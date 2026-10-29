'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, randomUUID, createHash } = require('crypto');
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
            CREATE INDEX IF NOT EXISTS observer_sessions_expiry ON observer_sessions(expires_at);
            CREATE TABLE IF NOT EXISTS observer_game_accounts (
                key_hash TEXT NOT NULL PRIMARY KEY REFERENCES observer_keys(key_hash) ON DELETE CASCADE,
                account_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                revision TEXT NOT NULL UNIQUE,
                linked_at INTEGER NOT NULL
            );`);
        this.findKey = this.db.prepare('SELECT key_hash, name FROM observer_keys WHERE key_hash = ?');
        this.findSession = this.db.prepare(`SELECT k.key_hash, k.name FROM observer_sessions s
            JOIN observer_keys k ON k.key_hash = s.key_hash WHERE s.token_hash = ? AND s.expires_at > ?`);
        this.findGameAccount = this.db.prepare(`SELECT account_name AS accountName, revision AS linkRevision, linked_at AS linkedAt
            FROM observer_game_accounts WHERE key_hash = ?`);
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

    authenticate(token) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
        const user = this.findSession.get(digest(token), Date.now());
        return user ? { principal: user.key_hash, user: { name: user.name, role: 'admin' } } : null;
    }

    session(token) { return this.authenticate(token)?.user || null; }

    gameAccount(principal) {
        return this.findGameAccount.get(principal) || null;
    }

    // Verification happens before this short transaction. SQLite, not a process-local
    // lock, arbitrates two principals claiming the same case-insensitive account.
    replaceGameAccount(principal, accountName, expectedRevision) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (!this.findKey.get(principal)) throw Config.error('Authentication required.', 401);
            if ((this.gameAccount(principal)?.linkRevision ?? null) !== expectedRevision) {
                throw Config.error('stale_link', 409);
            }
            const owner = this.db.prepare('SELECT key_hash FROM observer_game_accounts WHERE account_name = ? COLLATE NOCASE').get(accountName);
            if (owner && owner.key_hash !== principal) throw Config.error('account_already_linked', 409);
            this.db.prepare(`INSERT INTO observer_game_accounts VALUES (?, ?, ?, ?)
                ON CONFLICT(key_hash) DO UPDATE SET account_name = excluded.account_name,
                    revision = excluded.revision, linked_at = excluded.linked_at`)
                .run(principal, accountName, randomUUID(), Date.now());
            const link = this.gameAccount(principal);
            this.db.exec('COMMIT');
            return link;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }

    unlinkGameAccount(principal, expectedRevision) {
        const result = expectedRevision === null ? { changes: 0 }
            : this.db.prepare('DELETE FROM observer_game_accounts WHERE key_hash = ? AND revision = ?').run(principal, expectedRevision);
        if (!result.changes && (this.gameAccount(principal)?.linkRevision ?? null) !== expectedRevision) {
            throw Config.error('stale_link', 409);
        }
    }

    invalidateGameAccounts(scope = 'all') {
        // Observer auth is outside world saves. Invalidate before destructive work,
        // even if that operation later fails; names alone cannot prove continuity.
        const where = scope === 'bots' ? " WHERE account_name LIKE 'bot\\_%' ESCAPE '\\'"
            : scope === 'players' ? " WHERE account_name NOT LIKE 'bot\\_%' ESCAPE '\\'" : '';
        this.db.prepare(`DELETE FROM observer_game_accounts${where}`).run();
    }

    logout(token) {
        if (/^[A-Za-z0-9_-]{43}$/.test(token || '')) this.deleteSession.run(digest(token));
    }

    close() { this.db.close(); }
}

module.exports = { ObserverAuthStore, SESSION_SECONDS };
