'use strict';

const fs = require('fs');
const path = require('path');
const PUBLIC_DIR = path.join(__dirname, '..', 'frontend', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
function sendFile(request, response, file) {
    fs.stat(file, (error, stat) => {
        if (error || !stat.isFile()) { response.writeHead(404); response.end('Not found'); return; }
        const headers = { 'Cache-Control': response.getHeader('Cache-Control') || 'public, max-age=0, must-revalidate', ETag: `W/"asset-${stat.size}-${Math.floor(stat.mtimeMs)}"`, 'Last-Modified': stat.mtime.toUTCString() };
        if (request.headers['if-none-match'] === headers.ETag) { response.writeHead(304, headers); response.end(); return; }
        response.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size });
        if (request.method === 'HEAD') { response.end(); return; }
        const stream = fs.createReadStream(file);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
    });
}
function serveStatic(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) return false;
    if (url.pathname === '/' || url.pathname === '/observer') { response.writeHead(302, { Location: '/observer/' }); response.end(); return true; }
    if (!url.pathname.startsWith('/observer/') || url.pathname.startsWith('/observer/api/')) return false;
    let relative;
    if (/^\/observer\/settings(?:\/(?:world|bots|server|game-account))?\/?$/.test(url.pathname)) relative = 'settings.html';
    else if (url.pathname.startsWith('/observer/settings/')) return false;
    else if (/^\/observer\/database(?:\/(?:items|npcs)(?:\/\d+)?)?\/?$/.test(url.pathname)) relative = 'knowledge-base.html';
    else if (/^\/observer\/market\/?$/.test(url.pathname)) relative = 'market.html';
    else if (/^\/observer\/game-dashboard\/?$/.test(url.pathname)) relative = 'game-dashboard.html';
    else if (/^\/observer\/(?:world|overview|characters|parties|dungeons\/[a-z0-9_-]+|rankings|raid-bosses(?:\/\d+)?|clans(?:\/\d+)?(?:\/map)?|actors\/(?:bot|player)\/\d+)?\/?$/.test(url.pathname)) relative = 'index.html';
    else {
        try { relative = decodeURIComponent(url.pathname.slice('/observer/'.length)); }
        catch (_) { return false; }
    }
    const file = path.resolve(PUBLIC_DIR, relative);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || relative.includes('\\') || !MIME[path.extname(file)]) return false;
    sendFile(request, response, file);
    return true;
}
module.exports = { sendFile, serveStatic };
