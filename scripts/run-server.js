'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { ensureGeodata } = require('./geodata-bootstrap');
const rootDir = path.resolve(__dirname, '..');
const generation = process.env.L2NODE_MANAGED_GENERATION;
const managed = Boolean(generation && process.send);
let serverChild = null;
let shuttingDown = false;
let cleanup = 'unknown';
let finishing = false;
let deadline = null;

function send(message, callback = () => {}) {
    if (managed && process.connected) process.send({ ...message, v: 1, generation }, callback);
    else callback();
}
function finish(code, signal, confirmed = true) {
    if (finishing) return;
    finishing = true;
    if (deadline) clearTimeout(deadline);
    if (cleanup === 'clean' && (code !== 0 || signal)) cleanup = 'failed';
    const exitCode = code === 0 && cleanup === 'clean' ? 0 : 1;
    const timeout = setTimeout(() => process.exit(exitCode), 300);
    send({ type: 'tree-exited', confirmed, outcome: cleanup, code, signal: signal || null }, () => {
        clearTimeout(timeout); process.exit(exitCode);
    });
}
function stopServer(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!serverChild) { cleanup = 'unknown'; finish(1, null); return; }
    if (serverChild.connected) serverChild.send({ v: 1, type: 'shutdown', generation, reason: reason || 'wrapper_stop' }, error => {
        if (error) serverChild?.kill('SIGTERM');
    });
    else serverChild.kill('SIGTERM');
    deadline = setTimeout(() => {
        if (!serverChild) return;
        cleanup = 'timed_out';
        serverChild.kill('SIGKILL');
        // Keep the wrapper alive until the OS confirms exit. A kill request is
        // not evidence the descendant stopped or its buffered writes flushed.
        send({ type: 'shutdown-result', outcome: cleanup });
    }, 18000);
}
function startServer() {
    if (shuttingDown) return;
    console.info('Startup    :: starting NodeL2 with embedded SQLite');
    const child = serverChild = spawn(process.execPath, ['--openssl-legacy-provider', 'src/NodeL2'], {
        cwd: rootDir, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: process.env,
        windowsHide: process.platform === 'win32'
    });
    child.on('message', message => {
        if (message?.v !== 1 || message.generation !== generation) return;
        if (message.type === 'shutdown-result' && cleanup !== 'timed_out') cleanup = ['clean', 'failed', 'timed_out'].includes(message.outcome) ? message.outcome : 'unknown';
        if (['ready', 'startup-failed', 'settings.reply', 'shutdown-result'].includes(message.type)) send(message);
    });
    child.on('error', () => { cleanup = 'failed'; });
    child.on('close', (code, signal) => { serverChild = null; finish(code, signal); });
    child.on('disconnect', () => { if (!shuttingDown && serverChild === child) stopServer('runtime_ipc_lost'); });
}
async function main() {
    await ensureGeodata({ logger: message => console.info(`Startup    :: ${message}`) });
    startServer();
}
process.on('SIGINT', () => stopServer('SIGINT'));
process.on('SIGTERM', () => stopServer('SIGTERM'));
process.on('message', message => {
    if (message?.v !== 1 || message.generation !== generation) return;
    if (message.type === 'shutdown') stopServer(message.reason);
    else if (['settings.read', 'settings.apply'].includes(message.type) && serverChild?.connected && !shuttingDown) serverChild.send(message, () => {});
});
if (managed) process.on('disconnect', () => stopServer('management_ipc_lost'));
main().catch(error => {
    console.error(`Startup    :: geodata bootstrap failed: ${error.message}`);
    cleanup = 'failed'; send({ type: 'startup-failed' }); finish(1, null);
});
