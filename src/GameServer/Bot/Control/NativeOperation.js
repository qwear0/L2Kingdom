'use strict';

const { fault } = require('../../../Mcp/Contracts');

// This is a receipt for one accepted native unit, not a transaction manager.
// Once mutation starts, revocation stops future units but must not abandon the
// native unit's payment, award or publication tail. Unknown tails retain a hold.
function execute(run, work) {
    const { receipt, session } = run;
    let begun = false, settled = false, outcome = null;
    const operation = {
        check() {
            if (!begun && (!run.owner.isCurrent() || Date.now() >= run.deadline)) throw fault('authority_lost', 409);
            if (!begun && session.actor !== run.actor) throw fault('actor_changed', 409);
            if (!begun) run.validateAdmission?.();
        },
        begin() {
            operation.check(); begun = true; run.nativeStarted = true;
            receipt.executionOutcome = 'partial'; receipt.phase = 'native_settlement';
        },
        applied(details, publication = 'committed_pending_publication') {
            receipt.executionOutcome = 'partial'; receipt.publicationState = publication;
            receipt.sideEffects.nativeMutationNotRolledBack = true;
            receipt.evidence.nativeApplied = require('./Journal').compact(details);
            session.mcpObservation?.emit('service_applied', 'concrete_native_operation', details, receipt.actionId);
        },
        complete(details, gameplay = 'native_completed', publication = 'published') {
            settled = true; outcome = details;
            receipt.executionOutcome = begun ? 'applied' : 'not_applied';
            receipt.gameplayOutcome = gameplay; receipt.publicationState = run.publicationBlocked ? 'unknown' : publication;
            receipt.evidence.native = require('./Journal').compact(details);
            session.mcpObservation?.emit('service_completed', 'concrete_native_operation', { gameplay, publication, details }, receipt.actionId);
        },
        feedback(details) { receipt.evidence.nativeFeedback = require('./Journal').compact(details); },
        rolledBack() { begun = false; settled = true; run.nativeStarted = false; receipt.executionOutcome = 'not_applied'; receipt.publicationState = 'not_applicable'; },
        uncertain(reason) { run.publicationBlocked = true; receipt.reasonCode = reason; }
    };
    run.asyncPending = true; receipt.status = 'running'; receipt.phase = 'native_admission';
    Promise.resolve().then(() => { operation.check(); return work(operation); }).then(() => {
        run.asyncPending = false;
        if (begun && !settled || run.publicationBlocked) return block(receipt.reasonCode || 'native_publication_uncertain');
        if (run.cancelReason) { run.poll(); return; }
        run.finish(begun ? 'succeeded' : 'rejected', begun ? 'native_service_completed' : 'native_service_refused', 'native');
    }).catch(error => {
        run.asyncPending = false;
        receipt.evidence.nativeError = String(error.code || error.message || 'native_error').slice(0, 160);
        if (begun && !settled) block('native_settlement_uncertain');
        else if (run.cancelReason) run.poll();
        else run.fail(error.statusCode ? error.code : 'native_service_rejected', 'native');
        if (!error.statusCode) utils.infoWarn('BotControl', 'native service actor=%s action=%s error=%s', run.actor.fetchId(), receipt.actionId, error.message);
    });
    function block(reason) {
        run.publicationBlocked = true;
        Object.assign(receipt, { status: 'unknown', phase: 'publication_blocked', publicationState: 'unknown', reasonCode: reason, reasonSource: 'native' });
        session.mcpObservation?.emit('service_uncertain', 'concrete_native_operation', { reason, outcome }, receipt.actionId);
    }
}
module.exports = { execute };
