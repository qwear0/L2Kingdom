'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, createHash } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const Config = require('../ConfigLoader');
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const digest = value => createHash('sha256').update(value).digest('hex');
const validKey = value => typeof value === 'string' && /^wo_[A-Za-z0-9_-]{43}$/.test(value);

class ObserverAuthStore {
    constructor() {
        const directory = path.join(Config.resolve(process.env.L2NODE_RUNTIME_DIR || 'tmp'), 'observer-auth');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, 'auth.sqlite');
        fs.closeSync(fs.openSync(file, 'a', 0o600));
        this.db = new DatabaseSync(file);
        this.db.exec(`PRAGMA busy_timeout = 1000;
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS observer_keys (
                key_hash TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS observer_sessions (
                token_hash TEXT PRIMARY KEY,
                key_hash TEXT NOT NULL REFERENCES observer_keys(key_hash) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS observer_sessions_key ON observer_sessions(key_hash, expires_at);
            CREATE INDEX IF NOT EXISTS observer_sessions_expiry ON observer_sessions(expires_at);`);
        this.findKey = this.db.prepare('SELECT key_hash, name FROM observer_keys WHERE key_hash = ?');
        this.findSession = this.db.prepare(`SELECT k.name FROM observer_sessions s
            JOIN observer_keys k ON k.key_hash = s.key_hash WHERE s.token_hash = ? AND s.expires_at > ?`);
        this.insertSession = this.db.prepare('INSERT INTO observer_sessions VALUES (?, ?, ?)');
        this.deleteSession = this.db.prepare('DELETE FROM observer_sessions WHERE token_hash = ?');
        this.expireSessions = this.db.prepare('DELETE FROM observer_sessions WHERE expires_at <= ?');
        this.expireSessions.run(Date.now());
    }

    generate(name) {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
            throw new Error('Use a nonempty user name of at most 80 characters without control characters.');
        }
        name = name.trim();
        if (this.db.prepare('SELECT 1 FROM observer_keys WHERE name = ?').get(name)) {
            throw new Error('This user name already has a key. Choose a different name.');
        }
        const key = `wo_${randomBytes(32).toString('base64url')}`;
        this.db.prepare('INSERT INTO observer_keys VALUES (?, ?, ?)').run(digest(key), name, Date.now());
        return { name, key };
    }

    login(key) {
        if (!validKey(key)) return null;
        const user = this.findKey.get(digest(key));
        if (!user) return null;
        const token = randomBytes(32).toString('base64url');
        const now = Date.now();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.expireSessions.run(now);
            // Bound retained sessions per key; ordinary authenticated reads never write SQLite.
            this.db.prepare(`DELETE FROM observer_sessions WHERE key_hash = ? AND token_hash NOT IN
                (SELECT token_hash FROM observer_sessions WHERE key_hash = ? ORDER BY expires_at DESC LIMIT 9)`)
                .run(user.key_hash, user.key_hash);
            this.insertSession.run(digest(token), user.key_hash, now + SESSION_SECONDS * 1000);
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        return { token, user: { name: user.name, role: 'admin' } };
    }

    session(token) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
        const user = this.findSession.get(digest(token), Date.now());
        return user ? { name: user.name, role: 'admin' } : null;
    }

    logout(token) {
        if (/^[A-Za-z0-9_-]{43}$/.test(token || '')) this.deleteSession.run(digest(token));
    }

    close() { this.db.close(); }
}

module.exports = { ObserverAuthStore, SESSION_SECONDS };
