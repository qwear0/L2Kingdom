'use strict';

const { randomUUID } = require('crypto');
const { limits, fault } = require('../../../Mcp/Contracts');
const Authority = require('./Authority');
const Results = require('./Results');
const World = invoke('GameServer/World/World');
const pending = new Map();
const keyFor = input => `action:${input.sessionId}:${input.leaseId}:${input.requestId}`;
const position = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
function target(id) {
    const value = World.registeredActorById(id)?.actor || require('../../World/NpcObjectIndex').find(World, id);
    if (!value || value.fetchIsOnline?.() === false || value.corpseDecayState === 'removed') throw fault('target_unavailable', 409);
    return value;
}
function publicValue(entry) { return entry.receipt; }
function find(input) {
    const key = input.actionId ? null : keyFor(input);
    let entry = key ? pending.get(key) || Results.entries.get(key)?.value : null;
    if (input.actionId) {
        for (const run of pending.values()) if (run.receipt.actionId === input.actionId) { entry = run; break; }
        if (!entry) for (const saved of Results.entries.values()) if (saved.value.receipt?.actionId === input.actionId) { entry = saved.value; break; }
    }
    if (!entry || entry.sessionId !== input.sessionId) throw fault('request_expired', 410);
    return entry;
}
function read(input) { return publicValue(find(input)); }
function nativeOwner(run) {
    const { state, lease, actor, session } = run;
    const Summons = invoke('GameServer/Npc/SummonControl');
    const legalTarget = value => value && (value.fetchAttackable?.() === true || value.fetchIsSummon?.() === true)
        && require('../../World/NpcObjectIndex').find(World, value.fetchId()) === value
        && Summons.isValidEnemyTarget(actor, value);
    const Spoil = invoke('GameServer/Npc/SpoilSweep');
    const allowsSkill = skill => ['self', 'party', 'ally', 'pet', 'friendly', 'enemy'].includes(skill.fetchTargetKind())
        && !['recall', 'escape', 'teleport'].includes(String(skill.fetchSkillType?.()).toLowerCase())
        && !Spoil.isSpoilSkill(skill.fetchSelfId()) && !Spoil.isSpoilFestivalSkill(skill.fetchSelfId()) && !Spoil.isSweepSkill(skill.fetchSelfId());
    const legalActionTarget = (value, skill) => {
        if (!value || value.isDead?.() || value.fetchIsOnline?.() === false) return false;
        if (!skill) return legalTarget(value);
        const kind = skill.fetchTargetKind();
        if (['self', 'party', 'ally'].includes(kind) || skill.fetchSemantic?.().sourceTarget === 'aura') return value === actor;
        if (kind === 'pet') return value === Summons.activeSummon(actor);
        if (kind === 'friendly') return value === actor || invoke('GameServer/Bot/AI/PartyAwareness').partyActors(session).includes(value);
        return legalTarget(value);
    };
    const controller = { run: { recovery: false }, needsRecovery: () => false, legalTarget, legalActionTarget, allowsSkill,
        canInitiate: targets => targets.every(legalTarget), acceptTargets() {},
        rejectCandidate: () => run.fail('target_lookup_failed', 'native'),
        routeFailed: () => run.fail('movement_blocked', 'native') };
    const owner = { source: 'bot-mcp', run, controller,
        isCurrent: () => !run.done && !run.cancelReason && Authority.current(lease) && state.foreground === run,
        nativeEvent: (event, details) => run.event(event, details),
        acceptRoute: route => route.length <= 512 && route.every(point => Object.values(point).every(Number.isFinite)),
        approach(value, range, execute) {
            if (!owner.isCurrent()) return false;
            run.approach = { target: value, range, execute };
            run.receipt.phase = 'approaching';
            run.navigate(position(value), Math.min(32, range));
            return true;
        } };
    return owner;
}
function createRun(input, lease, key, fingerprint) {
    const state = lease.state, { actor, session } = state, now = Date.now();
    const receipt = { actionId: randomUUID(), requestId: input.requestId, sequence: input.sequence,
        runtimeEpoch: input.runtimeEpoch, actorRef: state.actorRef, controlGeneration: lease.generation,
        kind: input.command.kind, command: input.command, status: 'accepted', phase: 'dispatch', startedAt: now, updatedAt: now,
        executionOutcome: 'not_applied', gameplayOutcome: 'not_measured', publicationState: 'not_applicable',
        reasonCode: null, reasonSource: null, evidence: {}, sideEffects: {},
        completionCondition: input.command.until || input.command.kind, cancellable: true, eventCursor: null };
    const run = { state, lease, actor, session, sessionId: input.sessionId, fingerprint, receipt, input, key,
        done: false, nativePending: false, asyncPending: false, nativeStarted: false, lookupPending: false,
        deadline: now + input.timeoutMs, swings: 0, impacts: 0,
        finish(status, reason, source = 'adapter') {
            if (run.done) return;
            if (run.nativePending || run.asyncPending || run.publicationBlocked) {
                run.cancelReason = reason; receipt.phase = 'settling'; return;
            }
            run.done = true;
            if (run.summonOwner && run.summon?.autoFightCommandOwner === run.summonOwner) {
                invoke('GameServer/Npc/SummonControl').releaseAutoCommand(session, run.summon, run.summonOwner);
            }
            if (actor.automation.actionOwner === run.owner) actor.automation.abortAll(actor);
            if (actor.attack.queue.data?.actionOwner === run.owner) actor.attack.resetQueuedEvent();
            if (actor.storedAttack?.actionOwner === run.owner) actor.storedAttack = null;
            if (actor.storedSpell?.actionOwner === run.owner) actor.storedSpell = null;
            Object.assign(receipt, { status, reasonCode: reason, reasonSource: source, phase: 'terminal', updatedAt: Date.now(), cancellable: false });
            receipt.evidence.finalPosition = position(actor);
            receipt.evidence.afterSelf = { hp: actor.fetchHp(), mp: actor.fetchMp(), cp: actor.fetchCp(), targetId: actor.fetchDestId() || null };
            if (session.mcpObservation) {
                session.mcpObservation.emit('action_terminal', 'mcp_native_adapter', { status, reason, executionOutcome: receipt.executionOutcome,
                    gameplayOutcome: receipt.gameplayOutcome }, receipt.actionId);
                receipt.eventCursor = require('./Journal').cursor(session.mcpObservation);
            }
            pending.delete(key);
            if (state.foreground === run) state.foreground = null;
            Results.remember(key, { sessionId: input.sessionId, fingerprint, receipt });
            queueMicrotask(() => Authority.resume(state));
        },
        fail: (reason, source) => run.finish(run.nativeStarted ? 'failed' : 'rejected', reason, source),
        cancel(reason) {
            if (run.done) return;
            run.cancelReason = reason;
            actor.automation.abortAll(actor);
            actor.attack.resetQueuedEvent();
            actor.storedAttack = actor.storedSpell = null;
            const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
            if (summon?.autoFightCommandOwner?.nativeEvent === run.owner.nativeEvent) {
                invoke('GameServer/Npc/SummonControl').releaseAutoCommand(session, summon, summon.autoFightCommandOwner);
            }
            run.finish(reason === 'explicit_cancel' ? 'cancelled' : 'interrupted', reason);
        },
        event(event, details = {}) {
            if (run.done || event === 'native_cancelled' && !run.nativePending) return;
            receipt.updatedAt = Date.now();
            if (session.mcpObservation) session.mcpObservation.emit(event, 'concrete_native_action_owner', details, receipt.actionId);
            if (['swing_started', 'cast_started', 'summon_started'].includes(event)) {
                run.nativePending = run.nativeStarted = true;
                receipt.status = 'running'; receipt.phase = 'native_execution';
                receipt.evidence.nativeStartedAt = Date.now();
                receipt.executionOutcome = 'partial';
                receipt.sideEffects.nativeResourcesMayBeConsumed = true;
            }
            if (event === 'summon_commanded') { run.lookupPending = false; receipt.phase = 'summon_approaching'; }
            if (event === 'native_queued') receipt.phase = 'native_queued';
            if (event === 'native_rejected') { run.fail(details.reason, 'native'); return; }
            if (event === 'native_failed') run.nativeFailure = details.reason;
            if (event === 'cast_resources') { receipt.sideEffects.mpConsumed = details.mpCost; receipt.executionOutcome = 'applied'; }
            if (event === 'pickup_committing') { run.asyncPending = true; receipt.phase = 'claim_and_award'; }
            if (['swing_impact', 'cast_effect', 'summon_impact'].includes(event)) {
                run.impacts++;
                receipt.executionOutcome = 'applied';
                receipt.gameplayOutcome = event === 'cast_effect' ? (details.effective ? 'effective' : 'ineffective')
                    : details.hitLanded ? 'hit' : 'miss';
                receipt.evidence.impacts = run.impacts;
                receipt.evidence.hpDamage = Number(receipt.evidence.hpDamage || 0) + Number(details.hpDamage || 0);
                receipt.evidence.lastNativeOutcome = details;
                receipt.sideEffects.damageIsNotRolledBack = true;
            }
            if (['swing_end', 'cast_end', 'summon_end', 'native_cancelled'].includes(event)) {
                run.nativePending = false;
                run.swings++;
                receipt.evidence.nativeCompletions = run.swings;
                if (event === 'native_cancelled') run.cancelReason ||= 'native_interruption';
                // Resume only after the native callback has cleared its flags.
                queueMicrotask(() => run.poll());
            }
        },
        navigate(to, tolerance) {
            if (distance(position(actor), to) > 6000) throw fault('movement_budget', 409);
            run.destination = { ...to }; run.tolerance = tolerance;
            receipt.status = 'running'; receipt.phase = 'pathfinding';
            invoke(path.actor).moveTo(session, actor, { from: position(actor), to: { ...to }, arrivalRadius: tolerance,
                pathMaxNodes: 4000, actionOwner: run.owner });
        },
        poll() {
            if (run.done) return;
            receipt.updatedAt = Date.now();
            if (!Authority.current(lease) && !run.cancelReason) run.cancel('authority_lost');
            if (run.done) return;
            if (Date.now() >= run.deadline && !run.cancelReason) run.cancel('action_timeout');
            if (run.cancelReason) {
                if (!run.nativePending && !run.asyncPending && !run.publicationBlocked) {
                    run.finish(run.cancelReason === 'explicit_cancel' ? 'cancelled'
                        : run.cancelReason === 'action_timeout' ? 'failed' : 'interrupted', run.cancelReason);
                }
                return;
            }
            if (run.nativePending || run.asyncPending || run.publicationBlocked || run.lookupPending) return;
            if (run.nativeFailure) { run.finish('failed', run.nativeFailure, 'native'); return; }
            if (actor.attack.queue.data?.actionOwner === run.owner) { receipt.phase = 'native_queued'; return; }
            const moving = session.pendingPathRequest || session.moveTimer || actor.state.fetchTowards();
            if (run.destination) {
                const point = position(actor);
                const goal = run.approach ? position(run.approach.target) : run.destination;
                const tolerance = run.approach ? run.approach.range : run.tolerance;
                const arrived = distance(point, goal) <= tolerance && Math.abs(point.locZ - goal.locZ) <= 64;
                receipt.evidence.movement = { from: receipt.evidence.from, requestedTo: run.destination,
                    measured: point, xyTolerance: tolerance, zTolerance: 64, arrived, lowLodWarp: session.lastPathfinding?.lowLodWarp === true,
                    path: { strategy: session.lastPathfinding?.strategy, routeUsable: session.lastPathfinding?.routeUsable,
                        error: session.lastPathfinding?.error || null, reason: session.lastPathfinding?.reason || null } };
                if (arrived && !session.lastPathfinding?.lowLodWarp) {
                    actor.automation.abortAll(actor);
                    run.destination = null;
                    if (run.approach) { const next = run.approach.execute; run.approach = null; next(); }
                    else { receipt.executionOutcome = 'applied'; receipt.gameplayOutcome = 'arrived'; run.finish('succeeded', 'physical_arrival'); }
                } else if (!moving) run.fail(session.lastPathfinding?.error ? 'movement_blocked' : 'partial_or_unreachable_route', 'native');
                return;
            }
            if (input.command.kind === 'target') {
                if ((actor.fetchDestId() || null) === input.command.targetId) {
                    receipt.executionOutcome = 'applied'; receipt.gameplayOutcome = 'selected'; run.finish('succeeded', 'target_selected');
                } else run.fail('target_selection_failed', 'native');
            } else if (input.command.kind === 'attack') {
                if (run.swings && input.command.until === 'first_swing') run.finish(run.impacts ? 'succeeded' : 'interrupted', run.impacts ? 'first_native_swing' : 'native_swing_no_impact');
                else if (run.target.isDead()) run.finish(run.swings ? 'succeeded' : 'failed', 'target_dead');
                else if (input.command.until === 'bounded' && Date.now() - now >= input.command.durationMs) run.finish('succeeded', 'bounded_attack_finished');
                else invoke(path.actor).attackRequest(session, actor, { id: run.target.fetchId(), actionOwner: run.owner });
            } else if (input.command.kind === 'cast' || input.command.kind === 'summon') {
                if (run.summonOwner && !run.swings && run.summon.autoFightCommandOwner === run.summonOwner
                    && run.summon.controlMode === 'attack') return;
                if (run.swings) run.finish('succeeded', run.impacts ? 'native_execution_finished' : 'native_finished_no_effect_measured', 'native');
                else run.fail('native_action_not_started', 'native');
            }
        } };
    run.owner = nativeOwner(run);
    if (session.mcpObservation) {
        session.mcpObservation.emit('command_received', 'mcp', { requestId: input.requestId, command: input.command }, receipt.actionId);
        receipt.eventCursor = require('./Journal').cursor(session.mcpObservation);
    }
    receipt.evidence.beforeSelf = { hp: actor.fetchHp(), mp: actor.fetchMp(), cp: actor.fetchCp(), targetId: actor.fetchDestId() || null };
    receipt.evidence.from = position(actor);
    return run;
}
function start(run) {
    const { input, actor, session, receipt, owner } = run;
    const command = input.command, Generics = invoke(path.actor), Restrictions = invoke('GameServer/Effects/EffectRestrictions');
    if (command.kind === 'move') run.navigate(command.to, command.tolerance);
    else if (command.kind === 'approach') {
        const value = target(command.targetId);
        run.approach = { target: value, range: command.range, execute() { receipt.executionOutcome = 'applied'; receipt.gameplayOutcome = 'arrived'; run.finish('succeeded', 'physical_approach'); } };
        run.navigate(position(value), Math.min(32, command.range));
    } else if (command.kind === 'target') {
        if (command.targetId === null) { actor.unselect(); run.poll(); return; }
        const value = target(command.targetId);
        if (distance(position(actor), position(value)) > 2000 || Math.abs(actor.fetchLocZ() - value.fetchLocZ()) > 512) throw fault('target_outside_local_range', 409);
        Generics.select(session, actor, { id: command.targetId, selectionOnly: true, actionOwner: owner });
    } else if (command.kind === 'attack') {
        run.target = target(command.targetId);
        if (!owner.controller.legalTarget(run.target)) throw fault('native_target_ineligible', 409);
        Generics.attackRequest(session, actor, { id: command.targetId, actionOwner: owner });
    } else if (command.kind === 'cast') {
        const skill = actor.skillset.fetchSkill(command.skillId);
        if (!skill) throw fault('skill_not_learned', 409);
        if (!owner.controller.allowsSkill(skill)) throw fault('skill_target_or_travel_adapter_unavailable', 409);
        const Toggles = invoke('GameServer/Skills/ToggleSkills');
        const before = Toggles.isToggle(skill) ? Toggles.isActive(actor, skill) : null;
        if (before !== true && !actor.canUseSkill(skill)) throw fault('native_skill_reuse_or_condition', 409);
        Generics.skillRequest(session, actor, { selfId: command.skillId, id: command.targetId ?? actor.fetchDestId(), actionOwner: owner });
        if (before !== null) {
            const after = Toggles.isActive(actor, skill);
            receipt.executionOutcome = after !== before ? 'applied' : 'not_applied'; receipt.gameplayOutcome = after ? 'toggle_active' : 'toggle_inactive';
            receipt.evidence.toggle = { before, after };
            run.finish(after !== before ? 'succeeded' : 'rejected', 'native_toggle_state');
        }
    } else if (command.kind === 'state') {
        if (!Restrictions.canUseBasicAction(actor) || actor.isBlocked()) throw fault('native_state_blocked', 409);
        const before = command.property === 'seated' ? actor.state.fetchSeated() : actor.state.fetchWalkin();
        if (before !== command.value) Generics.basicAction(session, actor, { actionId: command.property === 'seated' ? 0 : 1, actionOwner: owner });
        const after = command.property === 'seated' ? actor.state.fetchSeated() : actor.state.fetchWalkin();
        receipt.evidence.desiredState = { property: command.property, requested: command.value, actual: after };
        receipt.executionOutcome = before === after ? 'not_applied' : 'applied';
        run.finish(after === command.value ? 'succeeded' : 'rejected', after === command.value ? 'desired_state' : 'native_state_rejected');
    } else if (command.kind === 'item' || command.kind === 'equip') {
        const item = actor.backpack.fetchItemRaw(command.itemId);
        if (!item || item.fetchPetLocked?.()) throw fault('item_unavailable', 409);
        if (command.kind === 'equip') {
            if (!item.isWearable() || invoke('GameServer/Pets/PetInventory').gear[item.fetchSelfId()]) throw fault('item_not_actor_equipment', 409);
            if (item.fetchEquipped() !== command.equipped) {
                if (command.equipped) actor.backpack.useItem(session, command.itemId);
                else actor.backpack.unequipGear(session, item.fetchSlot());
            }
            receipt.evidence.equipment = { itemId: command.itemId, equipped: item.fetchEquipped() };
            receipt.executionOutcome = item.fetchEquipped() === command.equipped ? 'applied' : 'not_applied';
            receipt.publicationState = 'live_applied_persistence_queued';
            run.finish(item.fetchEquipped() === command.equipped ? 'succeeded' : 'rejected', 'native_equipment_state');
        } else {
            const itemSkill = require('../../Items/C4ItemSkills').resolve(item.fetchSelfId());
            const shot = require('../../Inventory/ShotStock').kindForSelfId(item.fetchSelfId());
            const skill = itemSkill && actor.backpack.buildItemSkill(itemSkill);
            if (item.isWearable() || !shot && (!skill || !itemSkill.consume || itemSkill.handler || itemSkill.teleport || skill.fetchTargetKind() !== 'self'
                || skill.fetchHitTime() > 0)) throw fault('item_adapter_unavailable', 409);
            const before = item.fetchAmount();
            let effect = null;
            actor.backpack.useItem(session, command.itemId, { onSkillResult(outcome) {
                effect = { effective: invoke('GameServer/Bot/AI/BotActionFeedback').effective(outcome),
                    heal: outcome.heal || 0, mpRestore: outcome.mpRestore || 0, effect: Boolean(outcome.effect) };
            } });
            const after = actor.backpack.fetchItemRaw(command.itemId)?.fetchAmount() || 0;
            receipt.evidence.item = { itemId: command.itemId, before, after, effectOutcome: effect || (shot ? 'native_shot_charge' : 'not_measured') };
            receipt.gameplayOutcome = effect ? (effect.effective ? 'effective' : 'ineffective') : shot && after < before ? 'charged' : 'not_measured';
            receipt.sideEffects.consumed = Math.max(0, before - after);
            receipt.executionOutcome = after < before ? 'applied' : 'not_applied';
            receipt.publicationState = 'live_applied_persistence_queued';
            run.finish(after < before ? 'succeeded' : 'rejected', after < before ? 'native_item_consumed' : 'native_item_not_consumed');
        }
    } else if (command.kind === 'pickup') {
        Generics.pickupExec(session, actor, { id: command.groundItemId, actionOwner: owner }, result => {
            if (run.done) return;
            run.asyncPending = false;
            receipt.evidence.pickup = result;
            receipt.executionOutcome = result.status === 'awarded' ? 'applied' : result.status === 'award_failed' ? 'partial' : 'not_applied';
            receipt.gameplayOutcome = result.status;
            receipt.publicationState = result.status === 'award_failed' ? 'unknown' : result.status === 'awarded' ? 'published' : 'not_applicable';
            if (result.status === 'award_failed') {
                run.publicationBlocked = true;
                receipt.status = 'unknown'; receipt.phase = 'publication_blocked'; receipt.reasonCode = 'pickup_award_uncertain'; receipt.reasonSource = 'native';
            } else if (run.cancelReason) run.poll();
            else run.finish(result.status === 'awarded' ? 'succeeded' : 'rejected', result.status, 'native');
        }, () => owner.isCurrent());
    } else if (command.kind === 'summon') {
        const Summons = invoke('GameServer/Npc/SummonControl'), summon = Summons.activeSummon(actor);
        if (!summon || !Restrictions.canUseBasicAction(actor)) throw fault('summon_unavailable', 409);
        const commandOwner = { source: 'bot-mcp', isCurrent: command.command === 'attack' ? owner.isCurrent : () => Authority.current(run.lease),
            canAttack: value => owner.controller.legalTarget(value), nativeEvent: owner.nativeEvent };
        if (command.command === 'attack') {
            if (!command.targetId) throw fault('target_required');
            const value = target(command.targetId);
            if (!commandOwner.canAttack(value)) throw fault('native_target_ineligible', 409);
            if (Number(summon.fetchSummonSkillId?.()) === 301) throw fault('summon_no_basic_attack', 409);
            run.summon = summon; run.summonOwner = commandOwner; run.lookupPending = true;
            Summons.attack(session, actor, summon, { commandOwner, target: value });
        } else {
            if (command.command === 'follow') Summons.startFollowOwner(session, actor, summon, { commandOwner });
            else Summons.stop(session, summon);
            receipt.evidence.summon = { id: summon.fetchId(), controlMode: summon.controlMode };
            receipt.executionOutcome = 'applied'; receipt.gameplayOutcome = 'command_state_applied';
            run.finish('succeeded', 'native_summon_command');
        }
    }
}
function dispatch(input, attachmentFor) {
    const key = keyFor(input), fingerprint = JSON.stringify(input);
    const retained = pending.get(key) || Results.entries.get(key)?.value;
    if (retained) {
        if (retained.fingerprint !== fingerprint) throw fault('request_conflict', 409);
        return publicValue(retained);
    }
    const attachment = attachmentFor();
    const lease = Authority.requireLease(attachment, input);
    if (input.requestId <= Number(lease.requestHighWater || 0) || input.sequence <= lease.highWater) throw fault('request_expired', 410);
    if (input.sequence !== lease.highWater + 1) throw fault('request_out_of_order', 409, { nextSequence: lease.highWater + 1 });
    lease.highWater = input.sequence; lease.requestHighWater = input.requestId;
    const run = createRun(input, lease, key, fingerprint);
    if (input.command.kind !== 'stop') {
        if (pending.size >= limits.pendingActions) { run.fail('action_capacity'); return run.receipt; }
        if (lease.state.foreground) { run.receipt.evidence.conflictingActionId = lease.state.foreground.receipt.actionId; run.fail('foreground_busy'); return run.receipt; }
    }
    if (input.command.kind === 'stop') {
        const previous = lease.state.foreground;
        previous?.cancel('explicit_cancel');
        lease.idleUntil = Date.now() + limits.manualIdleMs;
        lease.aliveUntil = Date.now() + limits.leaseTtlMs;
        run.actor.automation.abortAll(run.actor); run.actor.attack.resetQueuedEvent();
        run.receipt.evidence.settlingActionId = previous && !previous.done ? previous.receipt.actionId : null;
        run.finish('succeeded', 'future_work_stopped'); return run.receipt;
    }
    lease.state.foreground = run; pending.set(key, run);
    try {
        const reasons = Authority.busy(lease.state.session);
        if (reasons.length) { run.receipt.evidence.busyReasons = reasons; run.fail('native_busy', 'native'); return run.receipt; }
        lease.idleUntil = Date.now() + limits.manualIdleMs;
        lease.aliveUntil = Math.min(Date.now() + limits.leaseTtlMs, lease.idleUntil);
        start(run);
    }
    catch (error) {
        if (!error.statusCode) {
            run.publicationBlocked = true;
            Object.assign(run.receipt, { status: 'unknown', phase: 'settlement_blocked', executionOutcome: 'unknown', reasonCode: 'dispatch_uncertain', reasonSource: 'adapter' });
            utils.infoWarn('BotControl', 'dispatch uncertain actor=%s error=%s', run.actor.fetchId(), error.message);
        } else run.fail(error.code, 'adapter');
    }
    return run.receipt;
}
function cancel(input, attachment) {
    const lease = Authority.requireLease(attachment, input), run = find(input);
    if (run.receipt.controlGeneration !== lease.generation || run.receipt.actorRef.characterId !== attachment.characterId) throw fault('stale_authority', 409);
    if (run.cancel) run.cancel('explicit_cancel');
    return { actionId: run.receipt.actionId, cancellationRequested: true, status: run.receipt.status };
}
module.exports = { dispatch, read, cancel, pendingCount: () => pending.size };
