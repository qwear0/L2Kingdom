const ActionOwner = invoke('GameServer/Actor/PlayerActionOwner');

function skillRequest(session, actor, data) {
    if (!ActionOwner.current(session, actor, data.actionOwner)) return;
    if (!data.actionOwner) ActionOwner.takeover(session, actor);
    const Generics = invoke(path.actor);
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
    const ToggleSkills = invoke('GameServer/Skills/ToggleSkills');
    const skill = actor.skillset.fetchSkill(data.selfId);

    if (actor.isDead()) {
        data.actionOwner?.nativeEvent?.('native_rejected', { reason: 'actor_dead' });
        return;
    }

    if (!skill || (data.actionOwner && !data.actionOwner.controller.allowsSkill(skill))) {
        return;
    }

    // A disabled toggle (notably Fake Death) must remain possible to switch
    // off even though its own state blocks ordinary skill use.
    if (ToggleSkills.isActive(actor, skill)) {
        ToggleSkills.handleRequest(session, actor, skill);
        return;
    }

    if (!EffectRestrictions.canCast(actor)) {
        const dressed = actor.backpack.isWearingFormalWear();
        data.actionOwner?.nativeEvent?.('native_rejected', { reason: dressed ? 'formal_wear' : 'cast_restricted' });
        if (dressed) {
            const ConsoleText = invoke('GameServer/ConsoleText');
            ConsoleText.transmit(session, ConsoleText.caption.formalWearCastRestricted);
        }
        EffectRestrictions.reject(session);
        return;
    }

    if (ToggleSkills.handleRequest(session, actor, skill)) {
        return;
    }

    // C4 TARGET_PARTY skills are caster-centered auras. The client does not
    // need to keep an explicit target selected in order to sing or dance.
    if (skill.fetchTargetKind() === 'pet') {
        const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
        if (!summon) return;
        data.id = summon.fetchId();
    }
    else if (
        skill.fetchTargetKind() === 'self' ||
        skill.fetchTargetKind() === 'party' ||
        skill.fetchTargetKind() === 'ally' ||
        skill.fetchTargetKind() === 'corpse_ally' ||
        skill.fetchSemantic?.().sourceTarget === 'aura'
    ) {
        data.id = actor.fetchId();
    }
    else {
        data.id = data.actionOwner ? data.id : actor.fetchDestId();
        // Lisvus TARGET_ONE explicitly permits SEED on the caster. With no
        // selected target, preserve that native self-seeding route.
        if (data.id === undefined && skill.fetchSkillType?.() === 'seed') {
            data.id = actor.fetchId();
        }
        else if (data.id === undefined) {
            data.actionOwner?.nativeEvent?.('native_rejected', { reason: 'target_required' });
            return;
        }
    }

    if (!actor.canUseSkill(skill)) {
        data.actionOwner?.nativeEvent?.('native_rejected', { reason: 'skill_reuse_or_condition' });
        EffectRestrictions.reject(session);
        return;
    }

    if (!data.actionOwner && !session.botSession && !session.accountId?.startsWith('bot_') && !data.resumeAttack) {
        const swing = (actor.state.fetchHits() || actor.attack.bowReloading) && actor.attack.activeSwing;
        const approach = actor.automation.playerAttackApproach;
        if (actor.attack.bowRepeatTarget && !actor.attack.bowRepeatOwner) {
            data.resumeAttack = { id: actor.attack.bowRepeatTarget.fetchId(), ctrl: actor.attack.bowRepeatCtrl };
        }
        else if (swing && !swing.actionOwner) {
            data.resumeAttack = { id: swing.targets[0].fetchId(), ctrl: swing.ctrl };
        }
        else if (approach && actor.state.fetchTowards() === 'melee') {
            data.resumeAttack = { id: approach.dst.fetchId(), ctrl: approach.ctrl };
        }
    }

    if (actor.isBlocked()) {
        data.actionOwner?.nativeEvent?.('native_queued');
        Generics.queueRequest(session, actor, 'skill', data);
        return;
    }

    if (data.actionOwner) {
        Generics.clearStoredActions(session, actor);
        Generics.stopAutomation(session, actor);
        Generics.skillExec(session, actor, data);
        return;
    }

    if (!EffectRestrictions.canMove(actor)) {
        Generics.skillExec(session, actor, data);
        return;
    }

    if (actor.state.inMotion()) {
        if (actor.state.fetchTowards() === 'melee' || actor.fetchDestId() !== actor.automation.fetchDestId()) {
            actor.storedSpell = data;
            Generics.stopAutomation(session, actor);
            return;
        }
    }

    if (actor.state.fetchTowards() === 'remote') {
        return;
    }

    actor.storedSpell = data;
    Generics.stopAutomation(session, actor);
}

module.exports = skillRequest;
