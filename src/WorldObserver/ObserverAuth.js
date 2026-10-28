'use strict';

const path = require('path');
const { ObserverAuthStore, SESSION_SECONDS } = require('./ObserverAuthStore');
const { readJson, sendJson } = require('./SettingsRoutes');
const { sendFile } = require('./ManagementStatic');
const { error } = require('../ConfigLoader');
const PUBLIC = new Set(['/observer/auth.js', '/observer/login.css', '/observer/appearance.js', '/observer/world-observer-logo.png']);
const LOGIN = '/observer/login';
const API = '/observer/api/auth/';

class ObserverAuth {
    constructor(port) {
        this.store = new ObserverAuthStore();
        // Cookies have no port scope; isolate management instances sharing a hostname.
        this.cookieName = `l2observer_session_${port}`;
        this.attempts = new Map();
    }

    token(request) {
        const cookies = String(request.headers.cookie || '').split(';').map(part => part.trim());
        return cookies.find(part => part.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1) || '';
    }

    cookie(request, token, maxAge) {
        return `${this.cookieName}=${token}; Path=/observer/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${request.socket.encrypted ? '; Secure' : ''}`;
    }

    rateLimit(request, response) {
        const now = Date.now(), peer = request.socket.remoteAddress;
        let entry = this.attempts.get(peer);
        if (!entry || entry.until <= now) {
            if (this.attempts.size >= 1024) {
                for (const [address, value] of this.attempts) if (value.until <= now) this.attempts.delete(address);
                if (this.attempts.size >= 1024) throw error('Login capacity exceeded. Try again later.', 429);
            }
            entry = { count: 0, until: now + 60000 };
            this.attempts.set(peer, entry);
        }
        if (++entry.count > 10) {
            response.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.until - now) / 1000))));
            throw error('Too many login attempts. Try again later.', 429);
        }
    }

    async handle(request, response, url) {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        if (PUBLIC.has(url.pathname) && ['GET', 'HEAD'].includes(request.method)) return false;
        const token = this.token(request);
        if (url.pathname === `${API}login`) {
            if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw error('Method not allowed.', 405); }
            this.rateLimit(request, response);
            const payload = await readJson(request);
            if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'key')) throw error('Supply only a personal key.');
            const session = this.store.login(payload.key);
            if (!session) throw error('Invalid personal key.', 401);
            this.store.logout(token);
            response.setHeader('Set-Cookie', this.cookie(request, session.token, SESSION_SECONDS));
            sendJson(response, { user: session.user });
            return true;
        }
        if (url.pathname === `${API}logout`) {
            if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw error('Method not allowed.', 405); }
            this.store.logout(token);
            response.setHeader('Set-Cookie', this.cookie(request, '', 0));
            sendJson(response, { ok: true });
            return true;
        }
        const user = this.store.session(token);
        if (url.pathname === LOGIN || url.pathname === `${LOGIN}/`) {
            if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); throw error('Method not allowed.', 405); }
            if (user) { response.writeHead(302, { Location: '/observer/' }); response.end(); }
            else sendFile(request, response, path.join(__dirname, 'public', 'login.html'));
            return true;
        }
        if (!user) {
            if (url.pathname.startsWith('/observer/api/') || !['GET', 'HEAD'].includes(request.method)) {
                sendJson(response, { error: 'Authentication required.' }, 401);
            } else {
                const next = url.pathname.startsWith('/observer/') ? url.pathname + url.search : '/observer/';
                response.writeHead(302, { Location: `${LOGIN}?next=${encodeURIComponent(next)}` });
                response.end();
            }
            return true;
        }
        if (url.pathname === `${API}session`) {
            if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw error('Method not allowed.', 405); }
            sendJson(response, { user });
            return true;
        }
        return false;
    }

    close() { this.store.close(); }
}

module.exports = ObserverAuth;
