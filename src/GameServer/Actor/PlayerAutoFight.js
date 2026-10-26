const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const Competition = invoke('GameServer/Bot/AI/BotMobCompetition');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const NpcObjectIndex = require('../World/NpcObjectIndex');
const CombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const Capabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const SupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const SummonerTactics = invoke('GameServer/Bot/AI/SummonerTactics');
const SummonControl = invoke('GameServer/Npc/SummonControl');
const PickupCapacity = invoke('GameServer/Inventory/PickupCapacity');
const Settings = require('./PlayerAutoFightSettings');

const loc = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
const MAX_SAFE_REST_MS = 6 * 60 * 60 * 1000;
const DEFENCE_RADIUS = 400;
const MAX_POINT_DISTANCE = 3000;

class PlayerAutoFight {
    static forActor(actor) {
        return actor.playerAutoFight ||= new PlayerAutoFight(actor);
    }

    constructor(actor) {
        this.actor = actor;
        this.session = actor.session;
        this.generation = 0;
        this.reason = 'stopped';
        this.center = null;
        this.point = null;
        this.applySettings(Settings.defaults());
        this.settingsStatus = 'unloaded';
        this.settingsSave = 'clean';
        this.settingsError = '';
        this.settingsEpoch = 0;
        this.settingsRevision = 0;
        this.settingsTask = null;
        this.skillRevision = 0;
        this.run = null;
    }

    applySettings(settings) {
        this.radius = settings.radius;
        this.allowedSkillIds = new Set(settings.allowedSkillIds);
        for (const key of ['basicAttackOnly', 'pickup', 'hpEnter', 'hpResume', 'mpEnter', 'mpResume']) this[key] = settings[key];
    }

    settingsSnapshot() {
        return { radius: this.radius, allowedSkillIds: [...this.allowedSkillIds], basicAttackOnly: this.basicAttackOnly,
            pickup: this.pickup, hpEnter: this.hpEnter, hpResume: this.hpResume, mpEnter: this.mpEnter, mpResume: this.mpResume };
    }

    settingsCurrent(epoch = this.settingsEpoch) {
        return epoch === this.settingsEpoch && this.session.actor === this.actor && this.actor.playerAutoFight === this
            && this.session.socket?.destroyed !== true;
    }

    loadSettings(retry = false) {
        if (!this.settingsCurrent() || this.settingsStatus === 'loading' || this.settingsStatus === 'ready') return this.settingsTask;
        if (this.settingsStatus !== 'unloaded' && !retry) return this.settingsTask;
        const epoch = this.settingsEpoch, revision = this.settingsRevision;
        const characterId = this.actor.fetchId(), accountId = this.session.accountId;
        this.settingsStatus = 'loading';
        this.settingsError = '';
        this.settingsTask = Promise.resolve().then(() => invoke('Database').fetchAutoFightSettings(characterId, accountId))
            .then(row => {
                if (!this.settingsCurrent(epoch) || revision !== this.settingsRevision) return;
                let settings;
                try { settings = row ? Settings.decode(row.settingsJson) : Settings.defaults(); }
                catch (_) {
                    this.settingsStatus = 'invalid';
                    this.settingsError = 'Stored preferences are invalid. Retry loading or explicitly replace them with defaults.';
                    return;
                }
                this.applySettings(settings);
                ++this.skillRevision;
                this.settingsStatus = 'ready';
                this.settingsSave = 'clean';
            }, () => {
                if (!this.settingsCurrent(epoch) || revision !== this.settingsRevision) return;
                this.settingsStatus = 'load_failed';
                this.settingsError = 'Could not load preferences. Start is blocked; retry loading or explicitly replace them with defaults.';
            });
        return this.settingsTask;
    }

    persistSettings() {
        const epoch = this.settingsEpoch, revision = ++this.settingsRevision;
        const settings = this.settingsSnapshot(), characterId = this.actor.fetchId(), accountId = this.session.accountId;
        this.settingsSave = 'saving';
        this.settingsError = '';
        // Database serializes immutable snapshots. Only the latest completion may
        // change the visible save state; earlier failures cannot mask later edits.
        this.settingsTask = Promise.resolve().then(() => invoke('Database').saveAutoFightSettings(characterId, accountId, settings,
            () => this.settingsCurrent(epoch) && this.session.accountId === accountId)).then(() => {
            if (this.settingsCurrent(epoch) && revision === this.settingsRevision) this.settingsSave = 'saved';
        }, () => {
            if (!this.settingsCurrent(epoch) || revision !== this.settingsRevision) return;
            this.settingsSave = 'failed';
            this.settingsError = 'Preferences changed in memory but were NOT saved. Retry saving before Start or logout.';
        });
        return this.settingsTask;
    }

    resetSettings() {
        if (this.run || !this.settingsCurrent() || this.settingsStatus === 'loading') return false;
        this.applySettings(Settings.defaults());
        ++this.skillRevision;
        this.settingsStatus = 'ready';
        this.persistSettings();
        return true;
    }

    retrySettingsSave() {
        if (!this.settingsCurrent() || this.settingsStatus !== 'ready' || this.settingsSave !== 'failed') return false;
        this.persistSettings();
        return true;
    }

    available() {
        const { session, actor } = this;
        return session.actor === actor && World.user.sessions.includes(session) && session.socket?.destroyed !== true
            && actor.fetchIsOnline() && !actor.state.fetchDead()
            && session.constructor?.name !== 'BotSession' && !session.accountId?.startsWith('bot_')
            && !session.pendingActorTeleport && !session.activeTrade && !actor.fetchPrivateStoreType?.()
            && !actor.fetchMounted?.() && !actor.mounted && !session.arenaDuelId
            && !actor.isFlying?.() && !actor.stateWater && !actor.fetchBoatId?.() && !actor.fetchBoat?.();
    }

    eligibleSkill(skill) {
        const semantic = skill?.fetchSemantic?.();
        if (!semantic || skill.fetchPassive() || semantic.notUsedInC4 || semantic.toggle) return false;
        const kind = skill.fetchTargetKind(), type = skill.fetchSkillType();
        if ([42, 254, 302].includes(Number(skill.fetchSelfId()))) return true;
        if (kind === 'enemy') return CombatUtility.OFFENSIVE_TYPES.has(type)
            && !(type === 'effect' && semantic.effectType === 'debuff');
        if (kind === 'self' && type === 'charge') return true;
        const Roles = invoke('GameServer/Bot/AI/BotRoles');
        if (SummonerTactics.isSummonSkill(skill)) return Roles.isSummoner(this.actor);
        if (SummonerTactics.isCorpseSummonSkill(skill)) return Roles.isNecromancer(this.actor);
        if (kind === 'pet') return SummonerTactics.PET_HEAL_IDS.has(Number(skill.fetchSelfId()))
            || SummonerTactics.PET_BUFF_IDS.has(Number(skill.fetchSelfId()));
        if (['friendly', 'party', 'ally'].includes(kind)
            && ['heal', 'healPercent', 'healStatic', 'healHot', 'hot', 'healCleanse'].includes(type)) return true;
        if (['friendly', 'party'].includes(kind) && ['manaRecharge', 'manaHeal'].includes(type)) return true;
        return ['self', 'friendly', 'party', 'ally'].includes(kind) && semantic.effectType === 'buff'
            && semantic.effect && !['hot', 'healHot', 'manaHot'].includes(type)
            && semantic.effect !== 'kiss_of_eva';
    }

    allowsSkill(skill) {
        return !this.basicAttackOnly && this.eligibleSkill(skill)
            && this.allowedSkillIds.has(Number(skill.fetchSelfId()))
            && this.actor.skillset.fetchSkill(skill.fetchSelfId()) === skill;
    }

    supportAvailable() {
        const run = this.run;
        return !!run && this.available() && !this.basicAttackOnly && !run.wait && !run.recovery
            && !this.needsRecovery() && ['seeking', 'fighting'].includes(run.state) && this.inside(this.actor);
    }

    legalActionTarget(target, skill) {
        if (!skill) return this.legalTarget(target);
        if (!this.allowsSkill(skill)) return false;
        const kind = skill.fetchTargetKind();
        if (kind === 'enemy') return target === this.actor && skill.fetchSemantic?.().sourceTarget === 'aura'
            ? true : this.legalTarget(target);
        if (kind === 'corpse_mob') return this.run?.corpses.get(target.fetchId()) === target
            && NpcObjectIndex.find(World, target.fetchId()) === target && target.isDead?.() && this.inside(target)
            && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(target);
        if (['self', 'party', 'ally'].includes(kind)) return target === this.actor;
        if (kind === 'pet') return SummonControl.activeSummon(this.actor) === target;
        return kind === 'friendly' && PartyAwareness.partyActors(this.session).includes(target)
            && !target.isDead?.() && distance(loc(this.actor), loc(target)) <= 900
            && Math.abs(target.fetchLocZ() - this.actor.fetchLocZ()) <= 64;
    }

    ordinaryMonster(target) {
        return target?.fetchKind?.() === 'Monster' && target.fetchAttackable?.() === true
            && NpcObjectIndex.find(World, target.fetchId()) === target
            && !target.fetchIsSummon?.() && !target.state?.fetchDead?.() && !target.isDead?.()
            && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(target);
    }

    members() {
        const members = PartyAwareness.partyActors(this.session);
        const SummonControl = invoke('GameServer/Npc/SummonControl');
        return [...members, ...members.map(member => SummonControl.activeSummon(member)).filter(Boolean)];
    }

    threatening(target, members = this.members()) {
        const targetId = Number(target.fetchDestId?.());
        return members.some(member => targetId === Number(member.fetchId()) || Number(target.getHating?.(member)) > 0
            || (Number(member.session?.incomingThreatId) === Number(target.fetchId())
                && Date.now() - Number(member.session?.incomingThreatAt || 0) < 5000));
    }

    inside(target, extra = 0) {
        const center = this.run?.center || this.center;
        return !!center && distance(loc(target), center) <= (this.run?.radius || this.radius) + extra
            && Math.abs(target.fetchLocZ() - center.locZ) <= 64;
    }

    engaged(target) {
        return this.run?.engaged.get(target.fetchId()) === target || this.threatening(target);
    }

    foreignEngagement(target) {
        const members = this.members();
        const claim = Competition.owner(target);
        if (claim && !members.includes(claim)) return true;
        const id = Number(target.fetchDestId?.());
        return id > 0 && !members.some(member => Number(member.fetchId()) === id);
    }

    canAcquire(target, source = this.actor) {
        const run = this.run;
        return !!run && this.available() && !run.recovery && !run.defenceAnchor && !this.needsRecovery()
            && !run.wait && !this.capacityBlocked() && !run.pickupPending && ['seeking', 'fighting'].includes(run.state)
            && !this.session.partyRevivalAttempt
            && !invoke('GameServer/Bot/AI/PartyPulling').hasDeadPartyMember(this.session)
            && this.ordinaryMonster(target) && this.inside(target) && this.inside(source)
            && !this.foreignEngagement(target) && Number(run.rejected.get(target.fetchId()) || 0) <= Date.now();
    }

    capacityBlocked() {
        if (this.run && PickupCapacity.full(this.actor)) this.run.capacityWait ||= 'inventory_full';
        return !!this.run?.capacityWait;
    }

    defending() {
        const run = this.run;
        return !!run && (!!run.defenceAnchor || !['seeking', 'fighting'].includes(run.state)
            || (run.state === 'seeking' && !this.inside(this.actor)));
    }

    legalTarget(target, source = this.actor) {
        const run = this.run;
        if (!run || !this.ordinaryMonster(target) || Math.abs(target.fetchLocZ() - source.fetchLocZ()) > 64) return false;
        if (this.threatening(target) && this.defending()) run.defenceAnchor ||= loc(this.actor);
        if (run.defenceAnchor) {
            return this.engaged(target) && distance(loc(target), run.defenceAnchor) <= DEFENCE_RADIUS
                && distance(loc(source), run.defenceAnchor) <= DEFENCE_RADIUS;
        }
        if (this.engaged(target)) return this.inside(target, 200) && this.inside(source, 200);
        return this.canAcquire(target, source);
    }

    canInitiate(targets, source = this.actor) {
        return this.available() && targets.length > 0 && targets.every(target => this.legalTarget(target, source));
    }

    acceptTargets(targets) {
        if (!this.run) return;
        for (const target of targets) this.run.engaged.set(target.fetchId(), target);
    }

    combatTargetId() {
        const target = this.run?.target;
        return target && this.legalTarget(target) ? target.fetchId() : null;
    }

    selectOnly(id) {
        if (!this.available()) return;
        this.actor.select({ id: Number(id), selectionOnly: true, actionOwner: this.run?.owner });
    }

    newSession() {
        this.stop('new_session');
        this.center = null;
        this.point = null;
        this.reason = 'setup';
    }

    rememberPoint(kind = 'rest') {
        if (this.run || !this.available()) return false;
        if (kind === 'center') this.center = loc(this.actor);
        else this.point = loc(this.actor);
        this.reason = `${kind}_set`;
        return true;
    }

    allowSkill(id) {
        if (!this.settingsCurrent() || this.settingsStatus !== 'ready') return false;
        const enabled = this.allowedSkillIds.has(id);
        if (!Number.isInteger(id) || id < 1 || id > 65535 || (this.run && !enabled)
            || (!enabled && this.allowedSkillIds.size >= Settings.MAX_SKILLS)) return false;
        const skill = this.actor.skillset.fetchSkill(id);
        if (!enabled && !this.eligibleSkill(skill)) return false;
        if (enabled) this.allowedSkillIds.delete(id);
        else this.allowedSkillIds.add(id);
        ++this.skillRevision;
        if (this.run) {
            SupportPlanner.cancelSupportCast(this.session, this.actor);
            // Preserve launched casts; invalidate unlaunched preparation and routes.
            const owner = this.run.owner;
            if (this.actor.attack.queue.data?.actionOwner === owner) this.actor.attack.resetQueuedEvent();
            if (this.actor.storedSpell?.actionOwner === owner) this.actor.storedSpell = undefined;
            this.clearTarget(this.run);
            if (this.run.owner === owner) this.renewOwner(this.run);
        }
        this.persistSettings();
        return true;
    }

    canEditSettings() {
        return !this.run && this.settingsCurrent() && this.settingsStatus === 'ready';
    }

    setBasicAttackOnly(value) {
        if (!this.canEditSettings() || typeof value !== 'boolean') return false;
        this.basicAttackOnly = value;
        ++this.skillRevision;
        this.persistSettings();
        return true;
    }

    setPickup(value) {
        if (!this.canEditSettings() || typeof value !== 'boolean') return false;
        this.pickup = value;
        this.persistSettings();
        return true;
    }

    setRadius(radius) {
        if (!this.canEditSettings() || !Settings.RADII.includes(radius)) return false;
        this.radius = radius;
        this.persistSettings();
        return true;
    }

    setThresholds(hpEnter, hpResume, mpEnter, mpResume) {
        if (!this.canEditSettings()) return false;
        try { Settings.validate({ ...this.settingsSnapshot(), hpEnter, hpResume, mpEnter, mpResume }); }
        catch (_) { return false; }
        Object.assign(this, { hpEnter, hpResume, mpEnter, mpResume });
        this.persistSettings();
        return true;
    }

    usesMana() {
        const actor = this.actor;
        if (actor.skillset.fetchSkills().some(skill => this.allowsSkill(skill)
            && actor.attack.skillMpCost(actor, skill) > 0)) return true;
        return AttackRange.weaponKind(actor) === 'Weapon.Bow'
            && invoke('GameServer/Items/C4WeaponSA').bowMpCost(actor.backpack.fetchEquippedWeapon(), () => 1) > 0;
    }

    needsRecovery(high = false) {
        const actor = this.actor;
        const hp = actor.fetchHp() / Math.max(1, actor.fetchMaxHp());
        const mp = actor.fetchMp() / Math.max(1, actor.fetchMaxMp());
        if (hp < (high ? this.hpResume : this.hpEnter) / 100
            || (this.usesMana() && mp < (high ? this.mpResume : this.mpEnter) / 100)) return true;
        return PartyAwareness.partyActors(this.session).some(member => member !== actor && RestPolicy.needsRest(member,
            member.fetchHp() / Math.max(1, member.fetchMaxHp()), member.fetchMp() / Math.max(1, member.fetchMaxMp()),
            { party: true, locked: high }));
    }

    busy() {
        const state = this.actor.state;
        return state.fetchHits() || state.fetchCasts() || state.fetchAnimated() || state.fetchPickinUp();
    }

    start() {
        const { actor, session } = this;
        if (this.run) return false;
        if (this.settingsStatus !== 'ready' || ['saving', 'failed'].includes(this.settingsSave)) {
            this.reason = this.settingsStatus === 'ready' ? `settings_${this.settingsSave}` : `settings_${this.settingsStatus}`;
            return false;
        }
        if (!this.available() || this.busy() || actor.state.inMotion()
            || session.moveTimer || session.pendingPathRequest || actor.attack.bowReloading) {
            this.reason = 'start_blocked';
            return false;
        }
        if (!this.center || !this.point) { this.reason = 'missing_points'; return false; }
        if (distance(this.center, this.point) > MAX_POINT_DISTANCE || distance(loc(actor), this.center) > MAX_POINT_DISTANCE) {
            this.reason = 'points_too_far';
            return false;
        }
        if (PickupCapacity.full(actor)) { this.reason = 'inventory_full'; return false; }
        invoke(path.actor).clearStoredActions(session, actor);
        actor.attack.resetQueuedEvent();
        actor.selectionRevision = Number(actor.selectionRevision || 0) + 1;
        const run = this.run = { generation: ++this.generation, kind: 'hunt', state: 'seeking',
            center: { ...this.center }, rest: { ...this.point }, radius: this.radius,
            engaged: new Map(), rejected: new Map(), recovery: false, nextScanAt: 0, nextActionAt: 0,
            safeRestMs: 0, fixedFailures: {}, defenceAnchor: null,
            corpses: new Map(), utilityAttempts: new Map(), rejectedLoot: new Map() };
        run.summonOwner = { isCurrent: () => this.run === run && this.available(),
            canAttack: (target, summon) => this.run === run && SummonControl.activeSummon(actor) === summon
                && this.legalTarget(target, summon) };
        this.renewOwner(run);
        this.reason = 'seeking';
        invoke('GameServer/Geodata/PlayerTransitionRecovery').cancel(session);
        PartyAwareness.invalidateThreatProjection(session);
        this.schedule(run);
        return true;
    }

    renewOwner(run) {
        const owner = run.owner = {
            source: 'player-auto-fight', controller: this, run,
            isCurrent: () => this.run === run && run.owner === owner
                && this.generation === run.generation && this.available(),
            approach: (target, radius, callback, skill) => this.approach(run, target, radius, callback, skill),
            acceptRoute: route => this.acceptRoute(run, route)
        };
    }

    setState(run, state, reason = state) {
        run.state = state;
        this.reason = reason;
    }

    setSeated(seated) {
        const { actor, session } = this;
        if (actor.state.fetchSeated() === seated) return true;
        if (this.busy() || actor.state.inMotion() || !Restrictions.canUseBasicAction(actor)) return false;
        actor.state.setSeated(seated);
        session.dataSendToMeAndOthers(Response.sitAndStand(actor), actor);
        return true;
    }

    approach(run, target, radius, callback, skill) {
        if (!run.owner.isCurrent() || !this.legalActionTarget(target, skill)) return false;
        run.approach = { target, radius, callback, skill };
        this.route(run, loc(target), 'candidate', { targetActor: target, arrivalRadius: Math.max(0, radius - 8),
            allowDeadTarget: skill?.fetchTargetKind() === 'corpse_mob' });
        return false;
    }

    route(run, destination, purpose, options = {}) {
        if (!Restrictions.canMove(this.actor) || !this.setSeated(false)) return false;
        run.route = { destination: { ...destination }, purpose, attempts: 1 + (run.fixedFailures[purpose] || 0), lastProgress: loc(this.actor),
            progressAt: Date.now(), deadline: Date.now() + 5000 };
        this.actor.moveTo({ from: loc(this.actor), to: { ...destination }, actionOwner: run.owner, ...options });
        return true;
    }

    // Validate the actual worker route before it can publish a segment. A
    // short straight-line distance must not authorize an unbounded detour.
    acceptRoute(run, route) {
        if (!run.owner.isCurrent() || !run.route || !route?.length) return false;
        let previous = loc(this.actor), length = 0;
        for (const waypoint of route) {
            length += distance(previous, waypoint);
            if (Math.abs(previous.locZ - waypoint.locZ) > 64) return false;
            if (run.route.purpose === 'candidate') {
                if (!this.legalActionTarget(run.approach.target, run.approach.skill)) return false;
                const anchor = run.defenceAnchor || run.center;
                const limit = run.defenceAnchor ? DEFENCE_RADIUS : run.radius + 200;
                if (distance(waypoint, anchor) > limit) return false;
            }
            if (run.route.purpose === 'loot' && (distance(waypoint, run.center) > run.radius
                || distance(waypoint, run.route.lastProgress) > 400)) return false;
            previous = waypoint;
        }
        const travelMs = length / Math.max(1, this.actor.fetchCollectiveRunSpd()) * 1000;
        if (length > 6000 || travelMs > 60000) return false;
        run.route.deadline = Date.now() + Math.min(90000, Math.max(5000, travelMs * 1.5 + 3000));
        run.route.progressAt = Date.now();
        return true;
    }

    clearTarget(run) {
        const hadAction = run.target || run.lookupPending || run.route;
        run.target = null;
        run.dispatched = false;
        run.lookupPending = false;
        run.nativeStarted = false;
        run.approach = null;
        if (this.actor.automation.actionOwner === run.owner) this.actor.automation.abortAll(this.actor);
        run.route = null;
        if (hadAction) this.renewOwner(run);
    }

    rejectCandidate(run) {
        if (this.run !== run) return;
        if (run.target) run.rejected.set(run.target.fetchId(), Date.now() + 30000);
        this.clearTarget(run);
        this.setState(run, 'seeking', 'candidate_unreachable');
    }

    routeFailed(run) {
        const route = run.route;
        if (!route) return;
        if (this.actor.automation.actionOwner === run.owner) this.actor.automation.abortAll(this.actor);
        if (route.purpose === 'loot') {
            if (run.loot) run.rejectedLoot.set(run.loot.fetchId(), Date.now() + 30000);
            run.loot = null;
            run.route = null;
            this.reason = 'loot_unreachable';
            return;
        }
        if (route.purpose === 'candidate') {
            this.rejectCandidate(run);
            return;
        }
        run.fixedFailures[route.purpose] = route.attempts;
        if (route.attempts < 2) {
            ++route.attempts;
            route.progressAt = Date.now();
            route.lastProgress = loc(this.actor);
            route.deadline = Date.now() + 5000;
            this.actor.moveTo({ from: loc(this.actor), to: { ...route.destination }, actionOwner: run.owner, forceRepath: true });
            return;
        }
        run.route = null;
        run.wait = 'path_blocked';
        this.setState(run, run.state, 'path_blocked');
    }

    tickRoute(run, now) {
        const route = run.route;
        if (!route) return false;
        const target = run.approach?.target;
        if (target && !this.legalActionTarget(target, run.approach.skill)) { this.clearTarget(run); return false; }
        const destination = target ? loc(target) : route.destination;
        const arrived = distance(loc(this.actor), destination) <= (run.approach?.radius ?? 24)
            && Math.abs(this.actor.fetchLocZ() - destination.locZ) <= 64
            && (!target || Geodata.hasLineOfSight(this.actor.fetchLocX(), this.actor.fetchLocY(), this.actor.fetchLocZ(),
                target.fetchLocX(), target.fetchLocY(), target.fetchLocZ()));
        if (arrived) {
            const approach = run.approach;
            if (this.actor.automation.actionOwner === run.owner) this.actor.automation.abortAll(this.actor);
            run.route = null;
            run.approach = null;
            if (approach) approach.callback();
            else {
                delete run.fixedFailures[route.purpose];
                if (route.purpose === 'rest') this.setState(run, 'resting');
                else this.setState(run, 'seeking');
            }
        } else {
            if (distance(loc(this.actor), route.lastProgress) >= 16) {
                route.lastProgress = loc(this.actor);
                route.progressAt = now;
            }
            if (now > route.deadline || now - route.progressAt > 5000
                || (!this.session.moveTimer && !this.session.pendingPathRequest)) this.routeFailed(run);
        }
        return true;
    }

    encounter(run) {
        const members = this.members();
        const nearby = new Map(run.engaged);
        const pending = new Set();
        for (const member of members) {
            const cast = member.attack?.activeCast;
            const swing = member.attack?.activeSwing;
            const castTargets = cast && ['enemy', 'corpse_mob'].includes(cast.skill.fetchTargetKind())
                ? cast.autoFightTargets || [cast.target] : [];
            const swingTargets = member.state?.fetchHits?.() || member.attack?.bowReloading ? swing?.targets || [] : [];
            for (const target of [...castTargets, ...swingTargets]) {
                if (!target) continue;
                pending.add(target);
                nearby.set(target.fetchId(), target);
            }
        }
        const partyThreat = PartyAwareness.findThreatTargetingPartyProjected(this.session);
        if (partyThreat?.actor) nearby.set(partyThreat.actor.fetchId(), partyThreat.actor);
        for (const member of members) {
            if (distance(loc(member), loc(this.actor)) > 1500) continue;
            for (const target of World.fetchNpcsInRadius(member.fetchLocX(), member.fetchLocY(), 1500)) nearby.set(target.fetchId(), target);
        }
        const active = [];
        for (const [id, target] of nearby) {
            const live = !target.state?.fetchDead?.() && !target.isDead?.();
            const threat = live && this.threatening(target, members);
            if (!live && target.fetchKind?.() === 'Monster' && NpcObjectIndex.find(World, id) === target
                && (run.engaged.has(id) || run.target === target || Number(target.model?.spoil?.spoilerId) === Number(this.actor.fetchId()))) {
                run.corpses.set(id, target);
                if (run.corpses.size > 32) run.corpses.delete(run.corpses.keys().next().value);
            }
            if (!this.ordinaryMonster(target)) {
                run.engaged.delete(id);
                if (threat) active.push(target);
                continue;
            }
            const summonAttacking = members.some(member => member.fetchIsSummon?.()
                && Number(member.fetchDestId?.()) === Number(id) && !!member.timer?.hit);
            const claimed = members.includes(Competition.owner(target));
            if (threat || claimed || summonAttacking || pending.has(target)) {
                if (summonAttacking || pending.has(target)) run.engaged.set(id, target);
                active.push(target);
            } else run.engaged.delete(id);
        }
        return active;
    }

    executable(skill) {
        return this.allowsSkill(skill) && Restrictions.canCast(this.actor) && this.actor.canUseSkill(skill)
            && this.actor.fetchMp() >= this.actor.attack.skillMpCost(this.actor, skill)
            && !this.actor.attack.skillUseConditionFailure(this.session, this.actor, skill);
    }

    cast(run, target, skill, now, support = null) {
        if (['self', 'party', 'ally'].includes(skill?.fetchTargetKind())) target = this.actor;
        if (!this.executable(skill) || !this.legalActionTarget(target, skill) || !this.setSeated(false)) return false;
        run.actionSkill = skill;
        if (skill.fetchTargetKind() === 'corpse_mob') run.target = target;
        run.nextActionAt = now + 500;
        run.lookupDeadline = now + 5000;
        if (support) SupportPlanner.queueSupportCast(this.session, { ...support, actionOwner: run.owner });
        invoke(path.actor).skillRequest(this.session, this.actor, {
            id: target.fetchId(), selfId: skill.fetchSelfId(), actionOwner: run.owner, ctrl: false
        });
        run.nativeStarted = this.actor.state.fetchCasts();
        return true;
    }

    supportAction(run, now, inCombat) {
        const actor = this.actor;
        const members = PartyAwareness.partyActors(this.session).filter(member => !member.isDead?.()
            && distance(loc(actor), loc(member)) <= 900 && Math.abs(actor.fetchLocZ() - member.fetchLocZ()) <= 64);
        const wounded = members.filter(member => member !== actor)
            .map(member => ({ actor: member, hpRatio: member.fetchHp() / Math.max(1, member.fetchMaxHp()) }))
            .sort((a, b) => a.hpRatio - b.hpRatio);
        const healing = invoke('GameServer/Bot/AI/BotHealingPolicy').select(actor, wounded[0],
            members.filter(member => member.fetchHp() / Math.max(1, member.fetchMaxHp()) < 0.70).length,
            actor.fetchHp() / Math.max(1, actor.fetchMaxHp()), actor.fetchMp() / Math.max(1, actor.fetchMaxMp()),
            { usableOnly: true }).action;
        if (healing && (!run.recovery || healing.emergency)
            && this.supportInRange(healing.target, healing.skill)
            && this.cast(run, healing.target, healing.skill, now)) return true;
        if (inCombat || !this.supportAvailable()) return false;
        const Pulling = invoke('GameServer/Bot/AI/PartyPulling');
        const action = SupportPlanner.nextAction(actor, Pulling.supportMembers(this.session), Pulling.supportProviders(this.session));
        if (action && this.supportInRange(action.target, action.skill)
            && this.cast(run, action.target, action.skill, now, action)) return true;
        const recharge = Capabilities.manaRechargeSkill(actor);
        const manaTarget = members.filter(member => member !== actor && member.fetchMp() / Math.max(1, member.fetchMaxMp()) < 0.60)
            .sort((a, b) => a.fetchMp() / Math.max(1, a.fetchMaxMp()) - b.fetchMp() / Math.max(1, b.fetchMaxMp()))[0];
        return !!manaTarget && !!recharge && this.supportInRange(manaTarget, recharge)
            && this.cast(run, manaTarget, recharge, now);
    }

    supportInRange(target, skill) {
        const radius = Number(skill.fetchDistance());
        return (skill.fetchTargetKind() !== 'friendly' || distance(loc(this.actor), loc(target)) <= 900)
            && Math.abs(this.actor.fetchLocZ() - target.fetchLocZ()) <= 64
            && (radius < 0 || distance(loc(this.actor), loc(target)) <= radius)
            && Geodata.hasLineOfSight(this.actor.fetchLocX(), this.actor.fetchLocY(), this.actor.fetchLocZ(),
                target.fetchLocX(), target.fetchLocY(), target.fetchLocZ());
    }

    summonAction(run, target, now) {
        const corpse = !target && [...run.corpses.values()].find(candidate => {
            const skill = SummonerTactics.corpseSummonSkill(this.actor, candidate);
            return skill && this.legalActionTarget(candidate, skill) && this.supportInRange(candidate, skill);
        });
        let cast = false;
        SummonerTactics.combatAction(this.session, this.actor, target || corpse || null, {
            skillExec: (_session, _actor, data) => {
                const skill = this.actor.skillset.fetchSkill(data.selfId);
                const recipient = data.id === this.actor.fetchId() ? this.actor
                    : SummonControl.activeSummon(this.actor)?.fetchId() === data.id ? SummonControl.activeSummon(this.actor)
                        : corpse || target;
                if (!run.recovery && recipient && this.supportInRange(recipient, skill)) cast = this.cast(run, recipient, skill, now);
            }
        }, { actionOwner: run.owner, commandOwner: run.summonOwner });
        return cast;
    }

    corpseAction(run, now) {
        const sweep = this.actor.skillset.fetchSkill(42);
        const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
        for (const [id, corpse] of run.corpses) {
            if (NpcObjectIndex.find(World, id) !== corpse) { run.corpses.delete(id); continue; }
            if (this.executable(sweep) && this.legalActionTarget(corpse, sweep) && SpoilSweep.isSweepable(corpse)
                && Number(corpse.model.spoil.spoilerId) === Number(this.actor.fetchId())
                && Number(run.rejected.get(id) || 0) <= now
                && distance(loc(this.actor), loc(corpse)) <= 200) return this.cast(run, corpse, sweep, now);
        }
        return false;
    }

    lootEligible(run, item) {
        return !!item && this.pickup && this.run === run && !run.recovery && !run.wait && !run.capacityWait && this.inside(this.actor)
            && World.items.spawns.includes(item)
            && invoke('GameServer/Bot/AI/PartyCompanionService').isOwnedPartyGroundLoot(this.session, item)
            && this.inside(item) && distance(loc(this.actor), loc(item)) <= 200
            && Math.abs(this.actor.fetchLocZ() - item.fetchLocZ()) <= 64;
    }

    pickupAction(run, now) {
        if (!this.pickup || run.pickupPending || run.recovery || run.wait || run.capacityWait) return false;
        const item = World.items.spawns.filter(candidate => this.lootEligible(run, candidate)
            && Number(run.rejectedLoot.get(candidate.fetchId()) || 0) <= now
            && Geodata.hasLineOfSight(this.actor.fetchLocX(), this.actor.fetchLocY(), this.actor.fetchLocZ(),
                candidate.fetchLocX(), candidate.fetchLocY(), candidate.fetchLocZ()))
            .sort((a, b) => distance(loc(this.actor), loc(a)) - distance(loc(this.actor), loc(b)))[0];
        if (!item) return false;
        run.loot = item;
        if (distance(loc(this.actor), loc(item)) > 32) {
            if (!this.route(run, loc(item), 'loot')) run.rejectedLoot.set(item.fetchId(), now + 30000);
            return true;
        }
        run.pickupPending = true;
        this.reason = 'picking_up';
        const owner = run.owner;
        invoke(path.actor).pickupExec(this.session, this.actor, { id: item.fetchId(), actionOwner: owner }, result => {
            if (this.run !== run) return;
            run.pickupPending = false;
            run.loot = null;
            run.rejectedLoot.set(item.fetchId(), Date.now() + 30000);
            if (result?.status === 'capacity') run.capacityWait = 'recipient_capacity';
            if (result?.status === 'award_failed') run.capacityWait = 'pickup_award_failed';
            if (run.capacityWait) this.reason = run.capacityWait;
        }, () => owner.isCurrent() && this.lootEligible(run, item) && !this.encounter(run).length);
        return true;
    }

    basicAvailable() {
        const actor = this.actor;
        if (!Restrictions.canAttack(actor)) return false;
        if (AttackRange.weaponKind(actor) !== 'Weapon.Bow') return true;
        const BowResources = invoke('GameServer/Actor/BowResources');
        const weapon = actor.backpack.fetchEquippedWeapon();
        const arrowId = BowResources.ARROWS[String(weapon?.fetchRank?.() || '').toLowerCase()];
        const arrow = arrowId && actor.backpack.fetchItemFromSelfId(arrowId);
        return !!arrow && arrow.fetchAmount() > 0 && !arrow.fetchPetLocked?.()
            && actor.fetchMp() >= invoke('GameServer/Items/C4WeaponSA').bowMpCost(weapon, () => 1);
    }

    dispatch(run, target, now) {
        const actor = this.actor;
        if (!this.setSeated(false)) return;
        const role = invoke('GameServer/Bot/AI/BotRoles').inferRole(actor);
        const policy = { session: this.session, skillAllowed: skill => this.executable(skill)
            && (skill.fetchTargetKind() !== 'enemy' || this.canInitiate(actor.attack.resolveSkillTargets(this.session, actor, target, skill))) };
        const utility = [254, 302].map(id => actor.skillset.fetchSkill(id)).find(skill => this.executable(skill)
            && !target.model?.spoil?.spoiled && invoke('GameServer/Npc/SpoilSweep').hasSpoils(target)
            && now - Number(run.utilityAttempts.get(target.fetchId()) || 0) >= 10000);
        if (utility && policy.skillAllowed(utility)) {
            run.target = target;
            run.utilityAttempts.set(target.fetchId(), now);
            if (this.cast(run, target, utility, now)) return;
        }
        const charge = !run.recovery && CombatUtility.selectChargePlan(actor, role,
            { ...policy, skillAllowed: skill => policy.skillAllowed(skill)
                || (this.allowsSkill(skill) && Number(skill.fetchSemantic?.().requires?.charges) > 0
                    && actor.canUseSkill(skill) && actor.fetchMp() >= actor.attack.skillMpCost(actor, skill)
                    && this.canInitiate(actor.attack.resolveSkillTargets(this.session, actor, target, skill))) }, target);
        if (charge && this.cast(run, actor, charge.skill, now)) return;
        const skill = CombatUtility.select(actor, target, role, policy)?.skill;
        if (!skill && !this.basicAvailable()) { this.reason = 'no_executable_action'; return; }
        const targets = skill ? actor.attack.resolveSkillTargets(this.session, actor, target, skill)
            : actor.attack.resolveMeleeTargets(actor, target);
        if (!this.canInitiate(targets)) { this.reason = 'unsafe_recipients'; return; }
        run.target = target;
        this.setState(run, 'fighting');
        run.dispatched = true;
        run.nativeStarted = false;
        run.lookupDeadline = now + 5000;
        run.nextActionAt = now + 500;
        if (run.publishedTarget !== target) {
            run.publishedTarget = target;
            actor.select({ id: target.fetchId(), selectionOnly: true, actionOwner: run.owner });
        }
        const data = { id: target.fetchId(), actionOwner: run.owner, ctrl: false };
        if (skill) invoke(path.actor).skillRequest(this.session, actor, { ...data, selfId: skill.fetchSelfId() });
        else invoke(path.actor).attackRequest(this.session, actor, data);
        run.nativeStarted ||= actor.state.fetchHits() || actor.state.fetchCasts();
    }

    schedule(run) {
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!run.owner.isCurrent()) { if (this.run === run) this.stop('actor_unavailable'); return; }
            try { this.tick(run); }
            catch (error) {
                this.stop('action_failed');
                utils.infoWarn('PlayerAutoFight', 'native action failed: %s', error?.stack || error?.message || String(error));
            }
            if (this.run === run) this.schedule(run);
        }, 250);
    }

    tick(run) {
        const { actor } = this;
        const now = Date.now();
        for (const [id, until] of run.rejected) if (until <= now) run.rejected.delete(id);
        for (const [id, at] of run.utilityAttempts) if (at < now - 30000) run.utilityAttempts.delete(id);
        if (this.needsRecovery()) run.recovery = true;
        if (run.lookupPending && now > run.lookupDeadline) this.rejectCandidate(run);
        if (actor.state.fetchHits() || actor.state.fetchCasts() || actor.attack.bowReloading || run.lookupPending) {
            run.safeRestSince = null;
            return;
        }
        if (now < run.nextScanAt) return;
        run.nextScanAt = now + 500;
        const encounter = this.encounter(run);
        this.capacityBlocked();
        for (const [id, until] of run.rejectedLoot) if (until <= now) run.rejectedLoot.delete(id);
        if (run.dispatched && !run.nativeStarted && !run.lookupPending && !run.route) this.rejectCandidate(run);
        const threats = encounter.filter(target => this.threatening(target));
        // Keep the interruption point through pursuit, adds and accepted native
        // actions; only a finished encounter may release the defence leash.
        if (!encounter.length) run.defenceAnchor = null;
        else if (threats.length && this.defending()) run.defenceAnchor ||= loc(actor);
        if (threats.some(target => !this.ordinaryMonster(target))) run.wait = 'unsupported_threat';
        else if (threats.some(target => !this.legalTarget(target))) run.wait = 'defence_leash';
        const readyTarget = target => this.legalTarget(target) && Number(run.rejected.get(target.fetchId()) || 0) <= now;
        const defensive = threats.find(readyTarget);
        if (encounter.length || run.route || run.state !== 'resting') run.safeRestSince = null;
        const activeEncounter = threats.length > 0 || encounter.some(target => this.legalTarget(target));
        if (run.route && activeEncounter && run.route.purpose !== 'candidate') {
            if (actor.automation.actionOwner === run.owner) actor.automation.abortAll(actor);
            run.route = null;
        }
        if (run.route?.purpose === 'loot' && (!this.lootEligible(run, run.loot) || activeEncounter)) {
            if (actor.automation.actionOwner === run.owner) actor.automation.abortAll(actor);
            run.route = null;
            run.loot = null;
        }
        if (!run.route && now >= run.nextActionAt && this.supportAction(run, now, activeEncounter)) return;
        if (this.tickRoute(run, now)) return;
        if (run.target && !this.legalTarget(run.target)) this.clearTarget(run);
        const target = defensive || encounter.find(readyTarget);
        if (target) {
            if (now >= run.nextActionAt && !this.summonAction(run, target, now)) this.dispatch(run, target, now);
            return;
        }
        this.clearTarget(run);
        // An attacker outside the defence envelope is still an encounter.
        // Never turn inability to hit it into permission to sit or pull again.
        if (threats.length) { this.reason = run.wait || 'defence_unreachable'; return; }
        if (run.wait) { this.reason = run.wait; return; }
        if (run.recovery) {
            if (run.state !== 'resting') {
                this.setState(run, 'returning_to_rest');
                if (!this.route(run, run.rest, 'rest')) this.reason = 'movement_restricted';
                return;
            }
            if (distance(loc(actor), run.rest) > 24 || Math.abs(actor.fetchLocZ() - run.rest.locZ) > 64) {
                this.setState(run, 'returning_to_rest');
                return;
            }
            if (!this.needsRecovery(true)) {
                run.recovery = false;
                run.safeRestMs = 0;
                if (!this.setSeated(false)) return;
                this.setState(run, 'returning_to_zone');
                this.route(run, run.center, 'zone');
                return;
            }
            if (this.setSeated(true)) {
                if (run.safeRestSince) run.safeRestMs += Math.min(1000, now - run.safeRestSince);
                run.safeRestSince = now;
            } else run.safeRestSince = null;
            this.reason = 'resting';
            if (run.safeRestMs >= MAX_SAFE_REST_MS) this.stop('recovery_timeout');
            return;
        }
        if (run.capacityWait) { this.reason = run.capacityWait; return; }
        if (run.pickupPending) { this.reason = 'picking_up'; return; }
        if (!this.inside(actor)) {
            this.setState(run, 'returning_to_zone');
            if (!this.route(run, run.center, 'zone')) this.reason = 'movement_restricted';
            return;
        }
        this.setState(run, 'seeking');
        if (now < run.nextActionAt) return;
        if (this.corpseAction(run, now) || this.summonAction(run, null, now) || this.pickupAction(run, now)) return;
        const candidates = World.fetchNpcsInRadius(run.center.locX, run.center.locY, run.radius)
            .filter(candidate => this.canAcquire(candidate) && Geodata.hasLineOfSight(
                actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(), candidate.fetchLocX(), candidate.fetchLocY(), candidate.fetchLocZ()))
            .sort((a, b) => distance(loc(actor), loc(a)) - distance(loc(actor), loc(b)));
        if (candidates.length) this.dispatch(run, candidates[0], now);
        else this.reason = 'no_targets';
    }

    // Route progression owns XY. Passive client reports can contribute heading
    // and nearby floor Z, but cannot confirm arrival or rewind a worker route.
    reconcilePosition(data) {
        const run = this.run;
        if (!run?.owner.isCurrent() || this.actor.automation.actionOwner !== run.owner) return data;
        const position = loc(this.actor);
        const nearby = distance(position, data) <= 128 && Math.abs(position.locZ - data.locZ) <= 64;
        return { ...data, ...position, ...(nearby ? { locZ: data.locZ } : {}) };
    }

    stop(reason = 'stopped') {
        const run = this.run;
        if (!run) return;
        this.run = null;
        ++this.generation;
        clearTimeout(this.timer);
        this.timer = null;
        this.reason = reason;
        const { actor } = this;
        const owner = run.owner;
        SupportPlanner.cancelSupportCast(this.session, actor);
        SummonControl.releaseAutoCommand(this.session, SummonControl.activeSummon(actor), run.summonOwner);
        if (actor.attack.queue.data?.actionOwner === owner) actor.attack.resetQueuedEvent();
        if (actor.attack.bowRepeatOwner === owner) {
            actor.attack.bowRepeatOwner = null;
            actor.attack.bowRepeatTarget = null;
        }
        for (const key of ['storedAttack', 'storedSpell', 'storedPickup']) {
            if (actor[key]?.actionOwner === owner) actor[key] = undefined;
        }
        if (actor.automation.actionOwner === owner) actor.automation.abortAll(actor);
        PartyAwareness.invalidateThreatProjection(this.session);
        // Already accepted native swings/casts are not cancelled by Stop.
        if (this.session.actor === actor && this.session.socket?.destroyed !== true) this.session.dataSendToMe(Response.speak(actor,
            { kind: 0, text: `Auto-fight: ${reason}.` }));
    }

    dispose(reason = 'disposed') {
        this.stop(reason);
        ++this.settingsEpoch;
        this.settingsTask = null;
        if (this.settingsStatus === 'loading') this.settingsStatus = 'unloaded';
        if (this.settingsSave === 'saving') {
            this.settingsSave = 'failed';
            this.settingsError = 'Save interrupted. Retry saving preferences before Start or logout.';
        }
        this.center = null;
        this.point = null;
        this.reason = reason;
        this.session.nativeAutoFightOpen = false;
    }
}

module.exports = PlayerAutoFight;
