#!/usr/bin/env node
'use strict';

// Keep stdout exclusive to SDK stdio framing. This entrypoint must never load
// Global/NodeL2, management startup, database modules or gameplay objects.
require('../src/Mcp/Server').run().catch(error => {
    console.error(`Bot MCP :: ${error.code || 'startup_failed'}`);
    process.exitCode = 1;
});
