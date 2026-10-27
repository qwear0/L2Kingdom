#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const Config = require('../src/ConfigLoader');
const ManagementController = require('../src/WorldObserver/ManagementController');
const SettingsService = require('../src/WorldObserver/SettingsService');
const { settingsRoute, sendJson } = require('../src/WorldObserver/SettingsRoutes');
const { access, managementRoute, proxy } = require('../src/WorldObserver/ManagementRoutes');
const { serveStatic } = require('../src/WorldObserver/ManagementStatic');
const BotControlRoutes = require('../src/WorldObserver/BotControlRoutes');
const controller = new ManagementController();
const settings = new SettingsService(controller);
const config = Config.load().effective.WorldObserver || {};
const hostname = config.hostname || '127.0.0.1';
const port = Number(config.port ?? 8088);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WorldObserver.port must be 1..65535.');
controller.binding = { hostname, port };

const server = http.createServer((request, response) => {
    (async () => {
        access(request, controller.binding);
        const url = new URL(request.url, 'http://localhost');
        if (await BotControlRoutes.proxy(request, response, url, controller)) return;
        if (await settingsRoute(request, response, url, settings)) return;
        if (await managementRoute(request, response, url, controller)) return;
        if (await proxy(request, response, url, controller)) return;
        if (serveStatic(request, response, url)) return;
        sendJson(response, { error: 'Not found.' }, 404);
    })().catch(error => sendJson(response, { error: error.statusCode ? error.message : 'Management request failed; inspect local configuration or service logs.' }, error.statusCode || 500));
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on('error', error => { console.error(`Management :: listener failed: ${error.message}`); process.exitCode = 1; shutdown(); });
server.listen(port, hostname, () => {
    const browserHost = ['0.0.0.0', '::'].includes(hostname) ? '127.0.0.1' : hostname;
    const url = `http://${browserHost.includes(':') ? `[${browserHost}]` : browserHost}:${port}/observer/settings/server`;
    console.info(`Management :: ready at ${url}`);
    if (process.env.L2NODE_NO_BROWSER === '1') return;
    const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const browser = spawn(command, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { detached: true, stdio: 'ignore' });
    browser.on('error', () => console.warn('Management :: could not open browser'));
    browser.unref();
});
let closing = false;
async function shutdown() {
    if (closing) return;
    closing = true;
    const closed = new Promise(resolve => server.close(resolve));
    try {
        await controller.shutdown(); await closed;
        const clean = controller.treeConfirmed && (!controller.lastExit || controller.shutdownOutcome === 'clean');
        process.exitCode = process.exitCode || (clean ? 0 : 1);
    }
    catch (_) { console.error('Management :: shutdown failed; descendant state is not confirmed'); process.exitCode = 1; }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
