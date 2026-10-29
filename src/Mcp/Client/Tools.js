'use strict';

const { schemas } = require('./Contracts');
function registerTools(server, bridge) {
    const tools = [
        ['client_status', 'Read the exact owned C4 client identity, native session observations, sample age and capabilities. Attaches via C4_CLIENT_SESSION; never launches a client or server. Auth acceptance is not consent or world entry.', schemas.empty, () => bridge.status()],
        ['client_observe', 'Read one bounded post-tick native pawn/ray sample and separately labelled network session observations. A login-scene level is not a player or complete loaded map. Contact/feet conventions remain uncalibrated.', schemas.empty, () => bridge.observe()],
        ['client_action', 'Queue a native session action with UUID requestId and observed expectedEpoch. login uses an absolute owner-private credentialFile, never credential values. select_server uses an observed serverId and expectedRevision; select_character uses the designated name from credentialFile and expectedRevision, matched exactly to the received list. move takes native floor XYZ within 512 XY/256 Z of the current origin and an explicit 1–15s deadline; only checked walking physics is admitted. stop supersedes foreground movement. Native manual movement through the checked outgoing intent path revokes control before forwarding that movement; passive position reports do not. No creation, terms acceptance, security-pad bypass or logout. Dispatch is not completion; inspect worldEntered and movement outcomes. XY/stationary arrival is not floor/vertical proof. Never replay unknown effects under a new key.', schemas.action, input => bridge.action(input)],
        ['client_action_status', 'Recover a retained native session-action receipt by the original UUID. Unknown means no permission to replay; the DLL retains at most 32 receipts for this client lifetime. Dispatched only confirms the native path was called (nativeReturn=null for void movement/stop). Inspect independent auth/list/world observations and native movement outcome/stop confirmation; stalled/timeout is not proven collision.', schemas.receipt, input => bridge.receipt(input)]
    ];
    for (const [name, description, inputSchema, handler] of tools) {
        server.registerTool(name, { description, inputSchema,
            annotations: { readOnlyHint: name !== 'client_action', destructiveHint: name === 'client_action',
                idempotentHint: true, openWorldHint: false } }, async input => {
            try {
                const result = await handler(input);
                return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
                    ...(result.error ? { isError: true } : {}) };
            } catch (error) {
                const code = typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'client_bridge_failed';
                const result = { error: code, guidance: 'Inspect client_status and the original client_action_status. Do not repeat an uncertain action with a new requestId. No automatic consent or gameplay recovery.' };
                return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
            }
        });
    }
}
module.exports = { registerTools };
