'use strict';

const { z } = require('zod');
const { schemas, epoch, ID, actorRef } = require('./Contracts');
function registerTools(server, bridge) {
    const tools = [
        ['bot_status', 'Read runtime capabilities, epoch and bridge session state. Never starts the game.', schemas.status, () => bridge.status()],
        ['bot_list', 'Page existing vassals of one exact owner. Offline actors cannot be attached.', schemas.list, input => bridge.request('list', input)],
        ['bot_attach', 'Observe an exact live actor without changing AI. First attach establishes a bridge namespace. Use requestId 1, then consecutive IDs; replay the same ID/payload after response loss.',
            z.strictObject({ runtimeEpoch: epoch, requestId: ID, actorRef }), input => bridge.mutate('attach', input)],
        ['bot_observe', 'Read a compact server-diagnostic self snapshot. P1 does not expose a local scene, events or gameplay authority.',
            z.strictObject({ attachmentId: z.uuid() }), input => bridge.read('observe', input)],
        ['bot_release', 'Close an observation attachment without changing AI. Uses the next requestId or an exact replay.',
            z.strictObject({ runtimeEpoch: epoch, requestId: ID, attachmentId: z.uuid() }), input => bridge.mutate('release', input)],
        ['bot_request_status', 'Recover a retained control request result even after the attachment closes. Unknown/expired results never permit automatic replay with a new ID.',
            z.strictObject({ requestId: ID }), input => bridge.read('request-status', input)]
    ];
    for (const [name, description, inputSchema, handler] of tools) {
        server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: !['bot_attach', 'bot_release'].includes(name),
            destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async input => {
            try {
                const result = await handler(input);
                return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
                    ...(result.error ? { isError: true } : {}) };
            } catch (error) {
                const result = { error: { code: error.code || 'bridge_failed', ...(error.details || {}) },
                    guidance: 'Inspect bot_status or the same bot_request_status; do not repeat an uncertain mutation under a new requestId.' };
                return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
            }
        });
    }
}
module.exports = { registerTools };
