#!/usr/bin/env node
'use strict';

const { ObserverAuthStore } = require('../src/WorldObserver/ObserverAuthStore');
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === '--help') {
    console[args[0] === '--help' ? 'log' : 'error']('Usage: npm run observer:key -- "User name"\nUses L2NODE_RUNTIME_DIR (default: tmp). Each user name must be unique.');
    process.exitCode = args[0] === '--help' ? 0 : 1;
} else {
    let store;
    try {
        store = new ObserverAuthStore();
        const { name, key } = store.generate(args[0]);
        console.log(`World Observer admin: ${name}\nPersonal key (shown only once):\n${key}`);
    } catch (error) {
        console.error(`Could not generate observer key: ${error.message}`);
        process.exitCode = 1;
    } finally { store?.close(); }
}
