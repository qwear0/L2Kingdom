'use strict';

const { error } = require('../ConfigLoader');
function sendJson(response, data, statusCode = 200) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
}
function readJson(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return Promise.reject(error('Expected application/json.', 415));
    return new Promise((resolve, reject) => {
        let bytes = 0, settled = false;
        const chunks = [];
        const fail = failure => { if (!settled) { settled = true; reject(failure); } };
        request.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 16384) { fail(error('Request body too large.', 413)); return; }
            if (!settled) chunks.push(chunk);
        });
        request.on('aborted', () => fail(error('Request interrupted.', 400)));
        request.on('error', () => fail(error('Request interrupted.', 400)));
        request.on('end', () => {
            if (settled) return;
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
                settled = true; resolve(body);
            } catch (_) { fail(error('Expected a JSON object.', 400)); }
        });
    });
}
async function settingsRoute(request, response, url, settings) {
    if (url.pathname !== '/observer/api/settings') return false;
    if (request.method === 'GET') sendJson(response, await settings.read());
    else if (request.method === 'PATCH') sendJson(response, await settings.patch(await readJson(request)));
    else { response.setHeader('Allow', 'GET, PATCH'); sendJson(response, { error: 'Method not allowed.' }, 405); }
    return true;
}
module.exports = { readJson, sendJson, settingsRoute };
