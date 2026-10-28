'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const Config = require('../ConfigLoader');
const { readJson, sendJson } = require('./SettingsRoutes');
const SavedGames = require('../../scripts/saved-games');
const BASE = '/observer/api/server/';
const loopback = peer => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
function privatePeer(raw) {
    const peer = String(raw || '').replace(/^::ffff:/, '');
    if (loopback(peer)) return true;
    if (net.isIPv4(peer)) {
        const [a, b] = peer.split('.').map(Number);
        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
            || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    }
    return net.isIPv6(peer) && /^(?:f[cd][\da-f]{2}:|fe[89ab][\da-f]:)/i.test(peer);
}
function parsePublicOrigin(value) {
    if (value === undefined || value === null || value === '') return '';
    const invalid = () => Config.error('WorldObserver.publicOrigin must be an absolute HTTP origin without credentials, path, query or fragment.');
    if (typeof value !== 'string' || !/^http:\/\/[^/?#@\\\s]+\/?$/.test(value)) throw invalid();
    let url;
    try { url = new URL(value); } catch (_) { throw invalid(); }
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid();
    return url.origin;
}
// Proxy authority is opt-in at the parent call site, never inferred from INI
// here: standalone observers retain their direct-peer contract. Keep the socket
// intact so independent loopback/token consumers cannot inherit client headers.
function access(request, binding, publicOrigin = '') {
    const forwarded = request.headers['x-real-ip'];
    const proxied = Boolean(publicOrigin && forwarded !== undefined);
    let clientAddress = request.socket.remoteAddress;
    if (proxied) {
        if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(clientAddress)
            || typeof forwarded !== 'string' || !net.isIP(forwarded)) throw Config.error('Invalid proxy client address.', 403);
        clientAddress = forwarded.replace(/^::ffff:/, '');
    }
    if (!privatePeer(clientAddress)) throw Config.error('Trusted LAN access only.', 403);
    let host;
    try { host = new URL(`http://${request.headers.host}`); } catch (_) { throw Config.error('Invalid Host.', 403); }
    if (host.username || host.password || host.pathname !== '/' || host.search || host.hash) throw Config.error('Unexpected Host.', 403);
    if (proxied) {
        if (host.origin !== publicOrigin) throw Config.error('Unexpected Host.', 403);
    } else {
        const hostname = host.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const bound = String(binding.hostname).toLowerCase();
        const expectedNames = new Set(['localhost', os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`, bound]);
        if (Number(host.port || 80) !== binding.port
            || !(expectedNames.has(hostname) || (['0.0.0.0', '::'].includes(bound) && privatePeer(hostname)))) throw Config.error('Unexpected Host.', 403);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
        if (request.headers['sec-fetch-site'] === 'cross-site') throw Config.error('Foreign browser origin denied.', 403);
        if (request.headers.origin && request.headers.origin !== host.origin) throw Config.error('Foreign browser origin denied.', 403);
    }
    return { clientAddress, proxied };
}
function keys(payload, allowed, required = []) {
    if (Object.keys(payload).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(payload, key))) throw Config.error('Unexpected or missing action fields.');
}
async function managementRoute(request, response, url, controller) {
    if (!url.pathname.startsWith(BASE)) return false;
    const action = url.pathname.slice(BASE.length);
    const read = ['status', 'logs', 'saves'].includes(action);
    const known = read || ['start', 'stop', 'progression', 'inference-test', 'saves/create', 'saves/load', 'saves/delete', 'wipe'].includes(action);
    if (!known) { sendJson(response, { error: 'Not found.' }, 404); return true; }
    if (request.method !== (read ? 'GET' : 'POST')) { response.setHeader('Allow', read ? 'GET' : 'POST'); sendJson(response, { error: 'Method not allowed.' }, 405); return true; }
    if (action === 'status') { sendJson(response, controller.public()); return true; }
    if (action === 'saves') { sendJson(response, { saves: await SavedGames.list(controller.savesDir) }); return true; }
    if (action === 'logs') {
        const file = fs.existsSync(controller.latestLog) ? controller.latestLog : controller.previousLog;
        if (!fs.existsSync(file)) { sendJson(response, { error: 'No server log yet.' }, 404); return true; }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        const stream = fs.createReadStream(file);
        stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
        return true;
    }
    const payload = await readJson(request);
    if (action === 'start' || action === 'stop' || action === 'inference-test') {
        keys(payload, []);
        sendJson(response, action === 'start' ? await controller.start() : action === 'stop' ? controller.stop() : await controller.testInference());
    } else if (action === 'progression') {
        keys(payload, ['revision', 'progressionRate'], ['revision', 'progressionRate']);
        controller.presets.save(payload); sendJson(response, controller.public());
    } else if (action.startsWith('saves/')) {
        const operation = action.slice('saves/'.length);
        keys(payload, operation === 'create' ? ['name'] : ['id', 'confirmed'], operation === 'create' ? [] : ['id', 'confirmed']);
        if (operation === 'create' && payload.name !== undefined && (typeof payload.name !== 'string' || payload.name.length > 120 || /[\x00-\x1f]/.test(payload.name))) throw Config.error('Invalid save name.');
        if (operation !== 'create' && (payload.confirmed !== true || typeof payload.id !== 'string' || !/^[0-9a-f-]{36}$/.test(payload.id))) throw Config.error('Confirm an existing save ID.');
        sendJson(response, await controller.dataOperation(operation, payload));
    } else if (action === 'wipe') {
        keys(payload, ['scope', 'confirmation'], ['scope', 'confirmation']);
        if (!['bots', 'players', 'all'].includes(payload.scope) || payload.confirmation !== `WIPE ${payload.scope.toUpperCase()}`) throw Config.error('Type the exact scope confirmation.');
        sendJson(response, await controller.dataOperation('wipe', payload));
    }
    return true;
}
// Known dynamic families only; there is no browser-selected upstream or generic
// proxy. The endpoint is learned exclusively from this generation's ready IPC.
function gameRoute(pathname) {
    return /^\/observer\/api\/(?:snapshot|world\/(?:bootstrap|changes|status)|characters\/search|clans(?:\/social)?|market(?:\/history)?|knowledge\/(?:meta|items(?:\/\d+)?|npcs(?:\/\d+)?)|clan-order-items|clan\/\d+(?:\/craft-preview|\/orders(?:\/\d+(?:\/(?:pause|resume|replan|cancel))?)?|\/crest)?|bot\/\d+(?:\/relationships)?|actor\/(?:bot|player)\/\d+(?:\/(?:inventory|warehouse|skills|pvp|board))?|control\/teleport-player-to-raid)$/.test(pathname)
        || /^\/observer\/item-icons\/[^/]+$/.test(pathname);
}
async function proxy(request, response, url, controller, context) {
    if (!gameRoute(url.pathname)) return false;
    if (url.pathname === '/observer/api/control/teleport-player-to-raid' && !loopback(context.clientAddress)) throw Config.error('loopback_only', 403);
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) throw Config.error('Method not allowed.', 405);
    const endpoint = controller.endpoint;
    if (controller.phase !== 'running' || !endpoint) { sendJson(response, { error: 'Game observer unavailable.', phase: controller.phase, observer: controller.public().observer }, 503); return true; }
    let body;
    const emptyDelete = request.method === 'DELETE' && !request.headers['transfer-encoding'] && !Number(request.headers['content-length'] || 0);
    if (request.method !== 'GET' && !emptyDelete) body = Buffer.from(JSON.stringify(await readJson(request)));
    if (controller.endpoint !== endpoint || endpoint.generation !== controller.generation) throw Config.error('Game generation changed.', 503);
    const headers = {};
    for (const key of ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since']) if (request.headers[key]) headers[key] = request.headers[key];
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
    const upstream = http.request({ hostname: endpoint.host, port: endpoint.port, path: url.pathname + url.search, method: request.method, headers }, incoming => {
        if (controller.endpoint !== endpoint || endpoint.generation !== controller.generation) { incoming.destroy(); sendJson(response, { error: 'Game generation changed.' }, 503); return; }
        const forwarded = { ...incoming.headers };
        for (const key of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'set-cookie', 'access-control-allow-origin']) delete forwarded[key];
        response.writeHead(incoming.statusCode, forwarded);
        incoming.on('error', () => response.destroy()); incoming.pipe(response);
    });
    const deadline = setTimeout(() => upstream.destroy(new Error('Upstream deadline exceeded')), 15000);
    upstream.on('close', () => clearTimeout(deadline));
    upstream.on('error', () => sendJson(response, { error: 'Game observer request failed or timed out.' }, 502));
    response.on('close', () => { clearTimeout(deadline); upstream.destroy(); });
    upstream.end(body);
    return true;
}
module.exports = { access, parsePublicOrigin, managementRoute, proxy, privatePeer, gameRoute };
