(function gameAccountPanel() {
    'use strict';
    const $ = id => document.getElementById(id);
    let active = false, loaded = false, link = null, busy = false, sequence = 0;
    const messages = {
        invalid_credentials: 'The game login or password is incorrect.',
        account_already_linked: 'That game account is linked to another frontend identity.',
        stale_link: 'The association changed. Review the refreshed association before submitting again.',
        runtime_unavailable: 'Start the game explicitly before verifying credentials.',
        runtime_timeout: 'Verification timed out. Refresh the association before any explicit retry.',
        rate_limited: 'Too many verification attempts. Wait at least one minute.',
        busy: 'Another verification is settling. Wait before submitting again.',
        invalid_request: 'Use a 1–14 character ASCII login and a nonempty password of at most 16 characters without control characters.'
    };
    function message(text) { $('gameAccountMessage').textContent = text; }
    function render() {
        $('gameAccountState').textContent = !loaded ? busy ? 'Reading association…' : 'Association unavailable. Refresh before changing it.' : link
            ? `Linked: ${link.accountName} · ${new Date(link.linkedAt).toLocaleString()}` : 'No game account linked.';
        $('linkGameAccount').disabled = busy || !loaded;
        $('unlinkGameAccount').disabled = busy || !loaded || !link;
        $('refreshGameAccount').disabled = busy;
        $('gameAccountLogin').disabled = busy;
        $('gameAccountPassword').disabled = busy;
        $('gameAccountForm').setAttribute('aria-busy', String(busy));
    }
    async function request(method, payload) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch('/observer/api/game-account', { method, cache: 'no-store', signal: controller.signal,
                ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
            const data = await response.json();
            if (!response.ok) throw Object.assign(new Error(messages[data.code] || `Association request failed (HTTP ${response.status}).`), { code: data.code });
            return data;
        } finally { clearTimeout(timer); }
    }
    async function refresh() {
        if (busy) return;
        const own = ++sequence;
        busy = true; render();
        try {
            const data = await request('GET');
            if (own !== sequence) return;
            link = data.link; loaded = true;
            message('Association refreshed. Link actions do not save unrelated Settings drafts.');
        } catch (error) { if (own === sequence) { loaded = false; message(error.message); } }
        finally { busy = false; render(); }
    }
    async function change(method) {
        if (busy || !loaded) return;
        const own = ++sequence;
        let payload = { expectedLinkRevision: link?.linkRevision ?? null };
        if (method === 'POST') {
            const login = $('gameAccountLogin').value, password = $('gameAccountPassword').value;
            $('gameAccountPassword').value = '';
            if (!/^[A-Za-z0-9_]{1,14}$/.test(login) || !password.trim() || password.length > 16 || /[\x00-\x1f\x7f]/.test(password)) {
                message(messages.invalid_request); return;
            }
            payload = { ...payload, login, password };
        }
        busy = true; render(); message('Waiting for association response…');
        try {
            // Only the bounded request holds the submitted secret; never retain it in page state.
            const pending = request(method, payload);
            delete payload.password; payload = null;
            const data = await pending;
            if (own !== sequence) return;
            link = data.link; loaded = true;
            message(link ? 'Game account linked. Open the Dashboard to control its online character.' : 'Association removed. Existing gameplay was not stopped.');
        } catch (error) {
            if (own !== sequence) return;
            loaded = false;
            message(`${error.message} No automatic retry. Refresh the association before another change.`);
        } finally { busy = false; render(); }
    }
    $('gameAccountForm').addEventListener('submit', event => { event.preventDefault(); change('POST'); });
    $('unlinkGameAccount').addEventListener('click', () => {
        if (link && window.confirm(`Unlink ${link.accountName}? Active gameplay will not be stopped.`)) change('DELETE');
    });
    $('refreshGameAccount').addEventListener('click', refresh);
    window.addEventListener('pagehide', () => { ++sequence; $('gameAccountPassword').value = ''; });
    window.addEventListener('pageshow', event => { if (event.persisted && active) refresh(); });
    window.WorldObserverGameAccount = {
        activate(value) {
            const entering = value && !active;
            active = value;
            if (!active) $('gameAccountPassword').value = '';
            if (entering) refresh();
        },
        refresh
    };
}());
