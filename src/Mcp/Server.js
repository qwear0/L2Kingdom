'use strict';

const { McpServer } = require('@modelcontextprotocol/server');
const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const GameBridge = require('./GameBridge');
const { registerTools } = require('./Tools');
async function run() {
    const bridge = new GameBridge();
    const server = new McpServer({ name: 'l2kingdom-bot-observer', version: require('../../package.json').version },
        { maxToolInputElements: 64 });
    registerTools(server, bridge);
    let closing = false;
    const shutdown = async () => {
        if (closing) return;
        closing = true;
        try { await bridge.close(); }
        catch (error) { console.error(`Bot MCP :: cleanup ${error.code || 'failed'}; attachments expire after 120s without heartbeat`); process.exitCode = 1; }
        await server.close();
    };
    server.server.onclose = () => { void shutdown(); };
    server.server.onerror = () => { console.error('Bot MCP :: protocol error'); };
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
    await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 }));
}
module.exports = { run };
