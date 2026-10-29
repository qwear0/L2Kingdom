#!/usr/bin/env node
'use strict';

require('../src/Mcp/Client/Server').run().catch(() => {
    console.error('C4 client MCP :: startup failed');
    process.exitCode = 1;
});
