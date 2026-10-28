'use strict';

const { timingSafeEqual } = require('crypto');
const http = require('http');
const { readJson, sendJson } = require('./SettingsRoutes');
const { bool } = require('./SettingsDescriptors');
const { schemas, limits, fault, parse } = require('../Mcp/Contracts');
const BASE = '/observer/api/bot-control/';
const HEADER = 'x-l2-bot-control-token';
const loopback = peer => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
let inFlight = 0, service = null, stopping = false;
function enabled(config) { return bool(config.BotControl?.enabled, false); }
function authorize(request, config) {
    if (!loopback(request.socket.remoteAddress)) throw fault('loopback_only', 403);
    // Browser-origin checks also apply at the private endpoint, not only the parent.
    if (request.headers.origin || request.headers['sec-fetch-site']) throw fault('browser_access_denied', 403);
    const host = request.headers.host || '';
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) throw fault('unexpected_host', 403);
    if (!enabled(config)) throw fault('bot_control_disabled', 503);
    const secret = process.env.L2NODE_BOT_CONTROL_TOKEN || '';
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw fault('bot_control_credentials_unconfigured', 503);
    const supplied = request.headers[HEADER];
    if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(supplied) || supplied.length !== secret.length
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) throw fault('unauthorized', 401);
}
async function readBody(request) {
    const deadline = setTimeout(() => request.destroy(), 10000);
    try { return await readJson(request); }
    finally { clearTimeout(deadline); }
}
function sendError(response, error) {
    sendJson(response, { error: { code: error.code && error.statusCode ? error.code : 'bot_control_failed',
        ...(error.details || {}) } }, error.statusCode || 500);
}
async function handle(request, response, url, config, dispatch) {
    if (!url.pathname.startsWith(BASE)) return false;
    try {
        authorize(request, config);
        const action = url.pathname.slice(BASE.length);
        if (!Object.hasOwn(schemas, action)) throw fault('not_found', 404);
        const method = action === 'status' ? 'GET' : 'POST';
        if (request.method !== method) { response.setHeader('Allow', method); throw fault('method_not_allowed', 405); }
        if (url.search) throw fault('invalid_request');
        if (inFlight >= limits.concurrentRequests) throw fault('request_capacity', 429);
        inFlight++;
        try {
            const payload = parse(action, action === 'status' ? {} : await readBody(request));
            await dispatch(action, payload);
        } finally { inFlight--; }
    } catch (error) { sendError(response, error); }
    return true;
}
function proxy(request, response, url, controller) {
    if (!url.pathname.startsWith(BASE)) return false;
    // The parent performs its normal access/Host checks before this handler.
    return handle(request, response, url, controller.config().effective, async (action, payload) => {
        const endpoint = controller.endpoint;
        if (controller.phase !== 'running' || !endpoint) throw fault('server_unavailable', 503,
            { phase: controller.phase, observer: controller.observerState, capabilities: { manualControl: false } });
        if (endpoint.generation !== controller.generation) throw fault('runtime_changed', 503);
        const body = action === 'status' ? null : Buffer.from(JSON.stringify(payload));
        await new Promise((resolve, reject) => {
            let finished = false;
            const finish = error => { if (!finished) { finished = true; error ? reject(error) : resolve(); } };
            const upstream = http.request({ hostname: endpoint.host, port: endpoint.port, path: BASE + action,
                method: request.method, headers: { [HEADER]: request.headers[HEADER], ...(body
                    ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, incoming => {
                const chunks = []; let bytes = 0;
                incoming.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > limits.responseBytes) upstream.destroy(fault('response_too_large', 502));
                    else chunks.push(chunk);
                });
                incoming.on('error', () => finish(fault('game_observer_unavailable', 502)));
                incoming.on('aborted', () => finish(fault('game_observer_unavailable', 502)));
                incoming.on('end', () => {
                    if (finished) return;
                    if (controller.phase !== 'running' || controller.endpoint !== endpoint || endpoint.generation !== controller.generation) {
                        finish(fault('runtime_changed', 503)); return;
                    }
                    try {
                        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        sendJson(response, data, incoming.statusCode); finish();
                    } catch (_) { finish(fault('invalid_upstream_response', 502)); }
                });
            });
            const timer = setTimeout(() => upstream.destroy(fault('game_observer_timeout', 504)), 12000);
            const onClose = () => { upstream.destroy(); finish(fault('request_interrupted', 499)); };
            response.once('close', onClose);
            upstream.once('error', error => finish(error.statusCode ? error : fault('game_observer_unavailable', 502)));
            upstream.once('close', () => { clearTimeout(timer); response.removeListener('close', onClose); });
            upstream.end(body);
        });
    });
}
function gameRoute(request, response, url) {
    if (!url.pathname.startsWith(BASE)) return false;
    void handle(request, response, url, options.default, async (action, payload) => {
        if (stopping) throw fault('server_unavailable', 503, { phase: 'stopping' });
        service ||= invoke('GameServer/Bot/Control/ControlService');
        sendJson(response, await service.dispatch(action, payload));
    });
    return true;
}
function shutdown() { stopping = true; service?.shutdown(); }
module.exports = { BASE, HEADER, enabled, proxy, gameRoute, shutdown };
