'use strict';

const { schemas } = require('./Contracts');
function registerTools(server, bridge) {
    const tools = [
        ['client_status', 'Read the exact owned C4 client identity, native session observations, sample age and capabilities. Attaches via C4_CLIENT_SESSION; never launches a client or server. Auth acceptance is not consent or world entry.', schemas.empty, () => bridge.status()],
        ['client_observe', 'Read one bounded post-tick native pawn/ray sample and separately labelled network session observations. A login-scene level is not a player or complete loaded map. Contact/feet conventions remain uncalibrated.', schemas.empty, () => bridge.observe()],
        ['client_action', 'Queue one native login using an absolute local owner-private credentialFile, never credential values. Use a fresh UUID requestId and observed expectedEpoch. Native dispatch is not completion; do not retry unknown effects under a new key. No terms acceptance, server selection, character creation, movement or logout is implemented.', schemas.login, input => bridge.action(input)],
        ['client_action_status', 'Recover a retained native login receipt by the original UUID. Unknown means no permission to replay; the DLL retains at most 32 receipts for this client lifetime. Dispatched only confirms the native path was called; inspect client_status for independent auth observations.', schemas.receipt, input => bridge.receipt(input)]
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
