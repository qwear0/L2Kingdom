'use strict';

const { schemas } = require('./Contracts');
function registerTools(server, bridge) {
    const tools = [
        ['client_status', 'Read the exact owned C4 client identity, native session observations, sample age and capabilities. Attaches via C4_CLIENT_SESSION; never launches a client or server. Auth acceptance is not consent or world entry.', schemas.empty, () => bridge.status()],
        ['client_observe', 'Read one bounded post-tick native pawn/ray sample and separately labelled network session observations. A login-scene level is not a player or complete loaded map. Contact/feet conventions remain uncalibrated.', schemas.empty, () => bridge.observe()],
        ['client_action', 'Queue a native session action with UUID requestId and observed expectedEpoch. login uses an absolute owner-private credentialFile, never credential values. select_server uses an observed serverId and expectedRevision; select_character uses the designated name from credentialFile and expectedRevision, matched exactly to the received list. move takes native floor XYZ within 512 XY/256 Z of the current origin and an explicit 1–15s deadline; only checked walking physics is admitted. stop supersedes foreground movement. Native manual movement through the checked outgoing intent path revokes control before forwarding that movement; passive position reports do not. No creation, terms acceptance, security-pad bypass or logout. Dispatch is not completion; inspect worldEntered and movement outcomes. XY/stationary arrival is not floor/vertical proof. Never replay unknown effects under a new key.', schemas.action, input => bridge.action(input)],
        ['client_action_status', 'Recover a retained native session-action receipt by the original UUID. Unknown means no permission to replay; the DLL retains at most 32 receipts for this client lifetime. Dispatched only confirms the native path was called (nativeReturn=null for void movement/stop). Inspect independent auth/list/world observations and native movement outcome/stop confirmation; stalled/timeout is not proven collision.', schemas.receipt, input => bridge.receipt(input)],
        ['client_events', 'Read up to 16 retained native journal entries after an instance-scoped cursor (instance from client_status, after=0 reads earliest retained history). The fixed 64-entry ring reports gap and nextCursor; reads never consume entries. Sample heartbeats are at most 1Hz; epoch/session/physics/owner/movement changes are detected at <=5Hz publication, not every callback or decoded packet. Receipt IDs correlate only their own movement outcomes, not all events.', schemas.events, input => bridge.events(input)],
        ['client_wait', 'Wait at most 30s, polling every 250ms, for a fixed observed predicate in expectedEpoch: world_entered; action_terminal for the original requestId (session dispatch is terminal only as dispatch, not world entry); stopped for that same latest movement receipt plus fresh native stationary samples; or a selected event kind after a cursor. Returns satisfied/reason, never turns timeout, event gap, stale samples, epoch change or terminal failure into gameplay success. One wait per adapter; cancellation stops waiting, not gameplay.', schemas.wait, (input, signal) => bridge.wait(input, signal)],
        ['client_capture', 'Start/read/stop/export a bounded native post-tick capture keyed by UUID captureId. Start requires expectedEpoch and 1–10s duration; one active capture, 8 retained captures/client, first 256 frames retained with explicit dropped/lock-skipped counters. Stop freezes telemetry only, not movement; deadline or epoch change also freezes. Read pages at most 16 frames. Export requires a finished capture and writes private capture.json below tmp/investigations/c4-client-agent/captures, returning only its path/summary. No arbitrary paths, screenshots, server diagnostics, decoded movement packets, correction classification or calibrated geometry. Reconnect using the same descriptor and ID; never replace uncertain capture IDs.', schemas.capture, (input, signal) => bridge.capture(input, signal)]
    ];
    for (const [name, description, inputSchema, handler] of tools) {
        server.registerTool(name, { description, inputSchema,
            annotations: { readOnlyHint: !['client_action', 'client_capture'].includes(name), destructiveHint: name === 'client_action',
                idempotentHint: name !== 'client_capture', openWorldHint: false } }, async (input, context) => {
            try {
                const result = await handler(input, context.signal);
                return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
                    ...(result.error ? { isError: true } : {}) };
            } catch (error) {
                const code = typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'client_bridge_failed';
                const result = { error: code, guidance: name === 'client_capture'
                    ? 'Inspect client_status and client_capture read using the original captureId and descriptor. Do not replace an uncertain capture key. Stop freezes telemetry, not gameplay.'
                    : 'Inspect client_status and the original client_action_status. Do not repeat an uncertain action with a new requestId. No automatic consent or gameplay recovery.' };
                return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
            }
        });
    }
}
module.exports = { registerTools };
