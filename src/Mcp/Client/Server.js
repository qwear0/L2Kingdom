'use strict';

const { McpServer } = require('@modelcontextprotocol/server');
const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const ClientBridge = require('./ClientBridge');
const { registerTools } = require('./Tools');
async function run() {
    const bridge = new ClientBridge();
    const server = new McpServer({ name: 'l2kingdom-c4-client', version: require('../../../package.json').version },
        { maxToolInputElements: 16 });
    registerTools(server, bridge);
    let closing = false;
    const shutdown = async () => {
        if (closing) return;
        closing = true;
        try { await bridge.close(); }
        catch { console.error('C4 client MCP :: release unconfirmed; the 15s owner lease revokes queued actions and requests native movement stop; stationary confirmation requires fresh native samples; dispatched session actions are not undone'); process.exitCode = 1; }
        await server.close();
    };
    server.server.onclose = () => { void shutdown(); };
    server.server.onerror = () => { console.error('C4 client MCP :: protocol error'); };
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
    await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16384 }));
}
module.exports = { run };
