#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const Config = require('../src/ConfigLoader');
const ManagementController = require('../src/WorldObserver/ManagementController');
const SettingsService = require('../src/WorldObserver/SettingsService');
const { settingsRoute, sendJson } = require('../src/WorldObserver/SettingsRoutes');
const { access, parsePublicOrigin, managementRoute, proxy } = require('../src/WorldObserver/ManagementRoutes');
const BotControlRoutes = require('../src/WorldObserver/BotControlRoutes');
const ObserverAuth = require('../src/WorldObserver/ObserverAuth');
const controller = new ManagementController();
const settings = new SettingsService(controller);
const config = Config.load().effective.WorldObserver || {};
const hostname = config.hostname || '127.0.0.1';
const port = Number(config.port ?? 8088);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WorldObserver.port must be 1..65535.');
const publicOrigin = parsePublicOrigin(config.publicOrigin);
if (publicOrigin && hostname !== '127.0.0.1') throw new Error('WorldObserver.hostname must be 127.0.0.1 when publicOrigin is set.');
controller.binding = { hostname, port, publicOrigin: config.publicOrigin ?? '' };
const auth = new ObserverAuth(port, { servePages: false });

const server = http.createServer((request, response) => {
    (async () => {
        const context = access(request, controller.binding, publicOrigin);
        const url = new URL(request.url, 'http://localhost');
        if (context.proxied && url.pathname.startsWith(BotControlRoutes.BASE)) throw Config.error('Direct loopback bot-control access only.', 403);
        if (await BotControlRoutes.proxy(request, response, url, controller)) return;
        if (await auth.handle(request, response, url, context)) return;
        if (await settingsRoute(request, response, url, settings)) return;
        if (await managementRoute(request, response, url, controller)) return;
        if (await proxy(request, response, url, controller, context)) return;
        sendJson(response, { error: 'Not found.' }, 404);
    })().catch(error => sendJson(response, { error: error.statusCode ? error.message : 'Management request failed; inspect local configuration or service logs.' }, error.statusCode || 500));
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on('error', error => { console.error(`Management :: listener failed: ${error.message}`); process.exitCode = 1; shutdown(); });
server.listen(port, hostname, () => {
    const browserHost = ['0.0.0.0', '::'].includes(hostname) ? '127.0.0.1' : hostname;
    const bindingOrigin = `http://${browserHost.includes(':') ? `[${browserHost}]` : browserHost}:${port}`;
    console.info(`Management :: API ready at ${bindingOrigin} (no browser pages)`);
    if (!publicOrigin) {
        console.info('Management :: no frontend origin configured; deploy the L2Kingdom frontend and set WorldObserver.publicOrigin.');
        return;
    }
    const url = `${publicOrigin}/observer/settings/server`;
    console.info(`L2Kingdom :: frontend at ${url} (availability is not checked)`);
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
        auth.close();
        const clean = controller.treeConfirmed && (!controller.lastExit || controller.shutdownOutcome === 'clean');
        process.exitCode = process.exitCode || (clean ? 0 : 1);
    }
    catch (_) { console.error('Management :: shutdown failed; descendant state is not confirmed'); process.exitCode = 1; }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
