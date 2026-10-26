const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const AttackRange = invoke('GameServer/Actor/AttackRange');

const loc = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);

// P1 deliberately exposes one native action, not a hunting scheduler. No
// acquisition, AoE, support, summon orders or durable preferences are enabled
// until their encounter/recipient policies are implemented in later phases.
class PlayerAutoFight {
    static forActor(actor) {
        return actor.playerAutoFight ||= new PlayerAutoFight(actor);
    }

    constructor(actor) {
        this.actor = actor;
        this.session = actor.session;
        this.generation = 0;
        this.reason = 'stopped';
        this.point = null;
        this.allowedSkillId = null;
        this.run = null;
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
        return !!semantic && !skill.fetchPassive() && skill.fetchTargetKind() === 'enemy'
            && ['damage', 'drain', 'blow'].includes(skill.fetchSkillType())
            && (!semantic.sourceTarget || semantic.sourceTarget === 'one')
            && !(Number(semantic.radius) > 0) && !semantic.toggle;
    }

    allowsSkill(skill) {
        return this.eligibleSkill(skill) && skill.fetchSelfId() === this.allowedSkillId;
    }

    legalTarget(target) {
        return target?.fetchKind?.() === 'Monster' && target.fetchAttackable?.() === true
            && !target.fetchIsSummon?.() && !target.state?.fetchDead?.()
            && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(target)
            && Math.abs(target.fetchLocZ() - this.actor.fetchLocZ()) <= 64
            && distance(loc(target), loc(this.actor)) <= 600;
    }

    selectOnly(id) {
        if (!this.available()) return;
        this.actor.select({ id: Number(id), selectionOnly: true, actionOwner: this.run?.owner });
    }

    rememberPoint() {
        if (this.run || !this.available()) return false;
        this.point = loc(this.actor);
        this.reason = 'point_set';
        return true;
    }

    allowSkill(id) {
        if (this.run) return false;
        const skill = this.actor.skillset.fetchSkill(Number(id));
        if (!this.eligibleSkill(skill)) return false;
        this.allowedSkillId = skill.fetchSelfId();
        return true;
    }

    start(kind, targetId) {
        const { actor, session } = this;
        if (this.run) return false;
        if (!this.available() || actor.state.isBlocked() || actor.state.inMotion()
            || session.moveTimer || session.pendingPathRequest || actor.attack.bowReloading) {
            this.reason = 'start_blocked';
            return false;
        }
        if (!['attack', 'skill', 'move'].includes(kind)) return false;
        if (kind === 'move' && !this.point) { this.reason = 'missing_point'; return false; }
        const skill = kind === 'skill' ? actor.skillset.fetchSkill(this.allowedSkillId) : null;
        if (kind === 'skill' && !this.allowsSkill(skill)) { this.reason = 'missing_allowed_skill'; return false; }
        if (kind === 'attack' && AttackRange.weaponKind(actor) === 'Weapon.Pole') {
            this.reason = 'p1_single_target_only';
            return false;
        }
        // Explicit Start replaces unlaunched native requests; a passive position
        // report must not dispatch an old stored spell during the owned route.
        invoke(path.actor).clearStoredActions(session, actor);
        actor.attack.resetQueuedEvent();
        actor.selectionRevision = Number(actor.selectionRevision || 0) + 1;
        const run = this.run = { generation: ++this.generation, kind, targetId: Number(targetId), startedAt: Date.now() };
        const owner = run.owner = {
            source: 'player-auto-fight', controller: this, run,
            isCurrent: () => this.run === run && this.generation === run.generation && this.available(),
            approach: (target, radius, callback) => this.approach(run, target, radius, callback)
        };
        this.reason = 'resolving';
        invoke('GameServer/Geodata/PlayerTransitionRecovery').cancel(session);
        if (kind === 'move') {
            this.route(run, { ...this.point });
        } else {
            World.fetchNpc(run.targetId).then(target => {
                if (!owner.isCurrent()) return;
                if (!this.legalTarget(target)) { this.stop('p1_illegal_target'); return; }
                run.target = target;
                const data = { id: run.targetId, actionOwner: owner, ctrl: false };
                this.reason = 'acting';
                run.dispatched = true;
                const Generics = invoke(path.actor);
                if (kind === 'attack') Generics.attackRequest(session, actor, data);
                else Generics.skillRequest(session, actor, { ...data, selfId: skill.fetchSelfId() });
            }).catch(error => {
                if (!owner.isCurrent()) return;
                this.stop('target_lookup_failed');
                utils.infoWarn('PlayerAutoFight', 'target lookup failed: %s', error?.message || String(error));
            });
        }
        this.schedule(run);
        return true;
    }

    approach(run, target, radius, callback) {
        if (!run.owner.isCurrent() || !this.legalTarget(target)) return false;
        run.approach = { target, radius, callback };
        this.route(run, loc(target), { targetActor: target, arrivalRadius: Math.max(0, radius - 8) });
        return false;
    }

    route(run, destination, options = {}) {
        run.destination = destination;
        run.routeDeadline = Date.now() + Math.min(120000, Math.max(5000,
            distance(loc(this.actor), destination) / Math.max(1, this.actor.fetchCollectiveRunSpd()) * 2000 + 3000));
        this.reason = 'moving';
        this.actor.moveTo({ from: loc(this.actor), to: { ...destination }, actionOwner: run.owner, ...options });
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
        }, 100);
    }

    tick(run) {
        const { actor, session } = this;
        if (Date.now() - run.startedAt > 120000) { this.stop('action_timeout'); return; }
        if (this.reason === 'moving') {
            if (actor.automation.actionOwner !== run.owner) { this.stop('movement_interrupted'); return; }
            const approach = run.approach;
            const target = approach?.target;
            if (target && !this.legalTarget(target)) { this.stop('target_unavailable'); return; }
            const destination = target ? loc(target) : run.destination;
            const arrived = distance(loc(actor), destination) <= (approach?.radius ?? 24)
                && Math.abs(actor.fetchLocZ() - destination.locZ) <= 64
                && (!target || Geodata.hasLineOfSight(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(),
                    target.fetchLocX(), target.fetchLocY(), target.fetchLocZ()));
            if (arrived) {
                if (actor.automation.actionOwner === run.owner) actor.automation.abortAll(actor);
                run.approach = null;
                this.reason = 'acting';
                if (approach) approach.callback();
                else this.stop('arrived');
            } else if (Date.now() > run.routeDeadline || (!session.moveTimer && !session.pendingPathRequest)) {
                this.stop('path_blocked');
            }
            return;
        }
        if (run.dispatched && !run.lookupPending && !actor.state.fetchHits() && !actor.state.fetchCasts()
            && !actor.attack.bowReloading && !actor.state.inMotion()) {
            this.stop(run.nativeStarted ? 'action_complete' : 'action_rejected');
        }
    }

    // Route progression owns XY. Passive client reports can contribute heading
    // and nearby floor Z, but must not rewind a worker route or confirm arrival
    // from an old MoveToPawn/StopMove. Outside the run, native validation is intact.
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
        if (actor.attack.queue.data?.actionOwner === owner) actor.attack.resetQueuedEvent();
        if (actor.attack.bowRepeatOwner === owner) {
            actor.attack.bowRepeatOwner = null;
            actor.attack.bowRepeatTarget = null;
        }
        for (const key of ['storedAttack', 'storedSpell', 'storedPickup']) {
            if (actor[key]?.actionOwner === owner) actor[key] = undefined;
        }
        if (actor.automation.actionOwner === owner) actor.automation.abortAll(actor);
        // Do not purge Attack timers: a launched swing/cast follows native
        // interruption rules. Its terminal callback may dispatch a queued
        // manual action, but may not repeat the cancelled automatic action.
        if (this.session.actor === actor && this.session.socket?.destroyed !== true) this.session.dataSendToMe(Response.speak(actor,
            { kind: 0, text: `Auto-fight P1: ${reason}.` }));
    }

    dispose(reason = 'disposed') {
        this.stop(reason);
        this.point = null;
        this.allowedSkillId = null;
        this.reason = reason;
        this.session.nativeAutoFightOpen = false;
    }
}

module.exports = PlayerAutoFight;
