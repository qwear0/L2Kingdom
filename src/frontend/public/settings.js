(function settingsPage() {
    'use strict';
    const Router = window.WorldObserverSpaRouter;
    const $ = id => document.getElementById(id);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const format = value => value === null || value === undefined ? 'unavailable' : typeof value === 'boolean' ? value ? 'on' : 'off' : String(value);
    const drafts = { world: {}, bots: {}, server: {} };
    let state = null, server = null, saving = false, acting = false, uncertain = false, allowLeave = false, presetDirty = false;
    let presetRevision = null, statusSequence = 0, managementUncertain = false;
    let tab = Router.parse(location.pathname).tab || 'world';
    let serverTimer = null, statusLoading = false, savesLoading = false;
    const fields = () => state?.fields.filter(field => field.tab === tab) || [];
    const hasDraft = (field) => Object.hasOwn(drafts[field.tab], field.id);
    function inputValue(field) { return hasDraft(field) ? drafts[field.tab][field.id] : field.saved; }
    function parsed(field, value) {
        if (value === null) return null;
        if (field.type === 'number' || field.type === 'integer') return value === '' ? NaN : Number(value) / (field.percent ? 100 : 1);
        return value;
    }
    function changed(field) {
        if (!hasDraft(field)) return false;
        const value = drafts[field.tab][field.id];
        if (value === null) return field.localOverride;
        return JSON.stringify(parsed(field, value)) !== JSON.stringify(field.saved);
    }
    function dirtyFields() { return state?.fields.filter(changed) || []; }
    function orphanDrafts(ownTab) { return Object.entries(drafts[ownTab]).filter(([id]) => !state?.fields.some(field => field.id === id)); }
    function draftCount() { return dirtyFields().length + Object.keys(drafts).reduce((sum, key) => sum + orphanDrafts(key).length, 0); }
    function message(text, error = false) { $('settingsMessage').textContent = text; $('settingsMessage').classList.toggle('settings-error', error); }
    async function request(url, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), url.endsWith('inference-test') ? 35000 : 12000);
        try {
            const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
            const data = await response.json();
            if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
            return data;
        } finally { clearTimeout(timer); }
    }
    const post = (action, payload = {}) => request(`/observer/api/server/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    function validateField(field) {
        if (!changed(field)) return '';
        const value = parsed(field, drafts[field.tab][field.id]);
        if (value === null) return field.optional ? '' : 'Cannot inherit this field.';
        if (field.type === 'number' || field.type === 'integer') {
            if (!Number.isFinite(value) || value < field.min || value > field.max || (field.type === 'integer' && !Number.isInteger(value))) return `Expected ${field.min}..${field.max}${field.type === 'integer' ? ' integer' : ''}.`;
        } else if (typeof value === 'string' && (!value.trim() || value.length > 200 || /[\r\n\x00-\x1f=;#\[\]]/.test(value))) return 'Enter a non-empty safe value, or use Inherit.';
        return '';
    }
    function updateDirty() {
        const current = fields().filter(changed), all = draftCount(), ownCount = current.length + orphanDrafts(tab).length;
        const errors = current.map(validateField).filter(Boolean);
        $('dirtyCount').textContent = `${ownCount} unsaved change${ownCount === 1 ? '' : 's'} in this tab${all !== ownCount ? ` (${all} across Settings)` : ''}${errors.length ? ' · fix validation errors' : ''}`;
        $('saveSettings').disabled = !current.length || errors.length > 0 || saving || uncertain;
        $('discardSettings').disabled = !Object.keys(drafts[tab]).length || saving;
        $('saveSettings').textContent = saving ? 'Saving…' : 'Save changes';
        document.querySelectorAll('[data-field-status]').forEach(element => {
            const field = state.fields.find(row => row.id === element.dataset.fieldStatus);
            const error = validateField(field);
            element.textContent = error || (changed(field) ? field.mode === 'restart' ? 'Unsaved; game restart required after Save.' : inputValue(field) === null ? 'Unsaved: remove only the local override.' : 'Unsaved; no runtime change until Save.' : field.status);
            element.classList.toggle('settings-error', Boolean(error));
        });
        renderProgression();
    }
    function renderProgression() {
        $('progressionSummary').hidden = tab !== 'world' || !state;
        if (tab !== 'world' || !state) return;
        const next = state.preset?.selected;
        const active = state.activePreset;
        const preview = new Map();
        for (const field of state.fields.filter(row => row.rate)) {
            let value = field.saved;
            if (hasDraft(field)) value = drafts.world[field.id] === null ? field.inherited : parsed(field, drafts.world[field.id]);
            preview.set(field.key, value);
        }
        for (const field of state.fields.filter(row => row.rate && row.sibling)) {
            const inheritSibling = hasDraft(field) ? drafts.world[field.id] === null && field.inheritedSiblingFallback : field.siblingFallback;
            if (inheritSibling) preview.set(field.key, preview.get(field.sibling));
        }
        const lines = state.fields.filter(row => row.rate).map(field => {
            const modifier = preview.get(field.key), activeProduct = modifier * Number(active?.slice(1)), nextProduct = modifier * Number(next?.slice(1));
            return `<small>${escape(field.label)} modifier ${escape(modifier)} → ${active ? `running-preset preview x${escape(activeProduct)}` : 'game stopped'}; ${next ? `next-start preview x${escape(nextProduct)}` : 'next preset invalid'}</small>`;
        });
        const rates = state.runningRates ? Object.entries(state.runningRates).filter(([key]) => !['multiplier', 'preset'].includes(key)).map(([key, value]) => `${key} x${value}`).join(' · ') : 'No confirmed running rates.';
        $('progressionSummary').innerHTML = `<h2>Progression</h2><p>Active preset: ${escape(active || 'none')} · Saved next start: ${escape(next || state.preset?.error || 'unavailable')}. <a href="/observer/settings/server" data-tab="server">Change the sole preset selector in Server management →</a></p><p>Actually running: ${escape(rates)}</p><div class="settings-input">${lines.join('')}</div><p>Previews include this draft, not applied values. Existing cumulative SP and variable-size reward limits are native constraints; see the runtime guide before exceptional rates.</p>`;
    }
    function fieldHtml(field) {
        const draft = inputValue(field), inheritedDraft = hasDraft(field) && draft === null;
        const displayed = inheritedDraft ? field.inherited : draft;
        const value = !hasDraft(field) || inheritedDraft ? field.percent ? Number(displayed) * 100 : displayed : displayed;
        const disabled = !field.editable || saving;
        const attrs = `id="setting-${escape(field.id)}" data-setting="${escape(field.id)}" aria-describedby="help-${escape(field.id)} status-${escape(field.id)}" ${disabled ? 'disabled' : ''}`;
        let input;
        if (!field.editable) input = `<output id="setting-${escape(field.id)}">${escape(format(field.saved))}</output>`;
        else if (field.type === 'boolean') input = `<input type="checkbox" ${attrs} ${displayed ? 'checked' : ''}>`;
        else if (field.choices) input = `<select ${attrs}>${field.choices.map(choice => `<option ${choice === displayed ? 'selected' : ''}>${escape(choice)}</option>`).join('')}</select>`;
        else input = `<input type="${['number', 'integer'].includes(field.type) ? 'number' : 'text'}" ${attrs} value="${escape(value)}" ${field.min !== undefined ? `min="${field.min * (field.percent ? 100 : 1)}" max="${field.max * (field.percent ? 100 : 1)}" step="${field.type === 'integer' ? 1 : 'any'}"` : 'maxlength="200"'}>`;
        return `<div class="settings-field"><div><label for="setting-${escape(field.id)}">${escape(field.label)}<span class="settings-badge">${escape(({ live: 'Live after Save', restart: 'Game restart', readonly: 'Read-only', service: 'Management restart' })[field.mode])}</span></label><p id="help-${escape(field.id)}">${escape(field.help)}</p><details><summary>Technical details</summary><p>${escape(field.id)} · default ${escape(format(field.default))}<br>Source: ${escape(field.source)} · ${field.localOverride ? `persisted local override ${escape(format(field.override))}` : 'inherited (no local override)'}<br>Without local override: ${escape(format(field.inherited))}${field.reason ? `<br>${escape(field.reason)}` : ''}</p></details></div><div class="settings-input">${input}${field.optional && field.editable ? `<button type="button" data-inherit="${escape(field.id)}" ${disabled ? 'disabled' : ''}>Inherit (remove local override)</button>` : ''}<small>Active: ${escape(format(field.active))} · Saved: ${escape(format(field.saved))}</small><span id="status-${escape(field.id)}" class="settings-status" data-field-status="${escape(field.id)}">${escape(field.status)}</span></div></div>`;
    }
    function render() {
        document.querySelectorAll('.settings-tabs [data-tab]').forEach(link => {
            if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        });
        $('serverManagement').hidden = tab !== 'server';
        $('tabDescription').textContent = tab === 'bots' ? 'Player-owned vassal behavior and optional AI dialogue.' : tab === 'world' ? 'Future operations use saved live values after confirmation; restart settings are never retroactive.' : 'The parent management service remains available when the game stops. Actions and the preset form never save unrelated drafts.';
        const groups = new Map();
        for (const field of fields()) { if (!groups.has(field.group)) groups.set(field.group, []); groups.get(field.group).push(field); }
        $('settingsFields').innerHTML = [...groups].map(([group, rows]) => `<section class="settings-card"><h2>${escape(group)}</h2><div class="${group === 'Enchant success (%)' ? 'settings-chance-grid' : ''}">${rows.map(fieldHtml).join('')}</div></section>`).join('');
        if (tab === 'bots' && state) $('settingsFields').insertAdjacentHTML('beforeend', `<section class="settings-card"><h2>Provider and credentials (read-only)</h2><p>Saved: ${escape(state.provider.provider)} · credentials ${escape(state.provider.credentials)}. Active: ${escape(state.provider.active?.provider || 'unavailable')} · credentials ${escape(state.provider.active?.credentials || 'unavailable')}. Provider URL/key editing is intentionally unavailable.</p></section>`);
        const orphans = orphanDrafts(tab);
        if (orphans.length) $('settingsFields').insertAdjacentHTML('beforeend', `<section class="settings-card"><h2>Retained drafts from a changed source</h2><p>These fields no longer belong to the current catalogue. They cannot be saved; review the new source or explicitly discard this tab's draft.</p><ul>${orphans.map(([id, value]) => `<li>${escape(id)}: ${escape(format(value))}</li>`).join('')}</ul></section>`);
        updateDirty(); renderPending();
        window.WorldObserverShell?.update({ name: 'settings', tab });
        clearTimeout(serverTimer);
        if (tab === 'server') refreshServer();
    }
    function navigate(next, push = true) {
        if (!['world', 'bots', 'server'].includes(next)) return;
        const enteringServer = tab !== 'server' && next === 'server';
        tab = next;
        if (push && location.pathname !== Router.href({ name: 'settings', tab })) history.pushState({}, '', Router.href({ name: 'settings', tab }));
        render();
        if (enteringServer) refreshSaves();
    }
    async function refreshSettings({ quiet = false } = {}) {
        try {
            state = await request('/observer/api/settings'); uncertain = false;
            if (!quiet) {
                if (presetDirty) presetRevision = state.preset.revision;
                message(state.runtimeError || (state.phase === 'running' ? 'Authoritative saved and running values loaded.' : 'Game is not running. Changes are saved for next start.'));
            }
            render();
            return true;
        } catch (error) { message(`Settings unavailable: ${error.message}. Drafts are retained.`, true); return false; }
    }
    $('settingsFields').addEventListener('input', event => {
        const input = event.target.closest('[data-setting]'); if (!input || !state) return;
        drafts[tab][input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
        updateDirty();
    });
    $('settingsFields').addEventListener('change', event => {
        if (event.target.matches('select[data-setting]')) { drafts[tab][event.target.dataset.setting] = event.target.value; updateDirty(); }
    });
    $('settingsFields').addEventListener('click', event => {
        const button = event.target.closest('[data-inherit]'); if (!button) return;
        drafts[tab][button.dataset.inherit] = null; render();
    });
    $('settingsForm').addEventListener('submit', async event => {
        event.preventDefault(); if (saving || uncertain || $('saveSettings').disabled) return;
        const saveTab = tab, targeted = fields().filter(changed);
        // Native whole-form constraints would reject unchanged legacy values.
        // Validate only the targeted draft, without clamping or rewriting others.
        if (!targeted.length || targeted.some(validateField)) { updateDirty(); return; }
        const changes = Object.fromEntries(targeted.map(field => [field.id, parsed(field, drafts[saveTab][field.id])]));
        saving = true; render();
        try {
            const result = await request('/observer/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, tab: saveTab, changes }) });
            state = result;
            for (const id of result.saved) delete drafts[saveTab][id];
            message(`${result.applied.length} changes confirmed active; ${result.pending.length} saved for next start / restart or live recovery. Review field statuses.`);
        } catch (error) {
            if (!error.status || error.status >= 500 || error.status === 409) {
                uncertain = true;
                const refreshed = await refreshSettings({ quiet: true });
                message(`${error.status === 409 ? 'Stale revision; draft retained.' : 'Save outcome uncertain; do not automatically retry.'} ${refreshed ? 'Authoritative values re-fetched; review saved versus active before another explicit edit/save.' : 'Refresh authoritative values before retrying.'}`, true);
            } else message(error.message, true);
        } finally { saving = false; render(); }
    });
    $('discardSettings').addEventListener('click', () => { drafts[tab] = {}; message('Only the unsaved draft was discarded. Persisted pending values were not reverted.'); render(); });
    $('refreshSettings').addEventListener('click', () => refreshSettings());
    document.addEventListener('click', event => {
        const link = event.target.closest('a'); if (event.defaultPrevented || !link?.hasAttribute('href') || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.target === '_blank') return;
        const route = Router.parse(new URL(link.href).pathname);
        if (route.name === 'settings') { event.preventDefault(); navigate(route.tab); }
        else if ((draftCount() || presetDirty) && !window.confirm('Leave Settings with unsaved drafts?')) event.preventDefault();
        else allowLeave = true;
    });
    window.addEventListener('observer:navigate', event => {
        if (event.detail.name === 'settings') { event.preventDefault(); navigate(event.detail.tab); }
    });
    window.addEventListener('popstate', () => { const route = Router.parse(location.pathname); if (route.name === 'settings') navigate(route.tab, false); });
    window.addEventListener('beforeunload', event => { if (!allowLeave && (draftCount() || presetDirty)) { event.preventDefault(); event.returnValue = ''; } });
    function renderPending() {
        if (!state) return;
        const pending = state.fields.filter(field => field.pending);
        $('pendingChanges').innerHTML = pending.length ? `<ul>${pending.map(field => `<li><a href="/observer/settings/${field.tab}" data-tab="${field.tab}">${escape(field.label)}</a>: ${escape(field.pending)} Active ${escape(format(field.active))}; saved ${escape(format(field.saved))}.</li>`).join('')}</ul>` : '<p>No confirmed running/saved differences.</p>';
    }
    function stopped() { return server && ['stopped', 'error'].includes(server.phase) && server.treeConfirmed && !server.pid && !server.operation && !acting && !managementUncertain; }
    function renderServer() {
        if (!server) return;
        $('serverStatus').textContent = `${managementUncertain ? 'Outcome unconfirmed; actions locked until a fresh status read. ' : ''}${server.phase} · readiness ${server.readiness ? 'confirmed' : 'not confirmed'} · observer ${server.observer} · cleanup ${server.shutdownOutcome}`;
        $('serverMeta').textContent = `PID ${server.pid || '—'} · uptime ${Math.floor(server.uptimeMs / 1000)} s · last exit ${server.lastExit ? JSON.stringify(server.lastExit) : 'none'} · descendant exit ${server.treeConfirmed ? 'confirmed / not started' : 'not confirmed'}`;
        $('serverOperation').textContent = server.operation ? `Operation ${server.operation.kind} (${server.operation.id}) in progress. HTTP disconnect does not cancel it.` : server.lastOperation ? `Last operation: ${JSON.stringify(server.lastOperation)}` : 'No management operations yet.';
        $('startServer').disabled = !stopped() || Boolean(server.preset.error);
        $('stopServer').disabled = acting || managementUncertain || Boolean(server.operation) || !server.pid || server.phase === 'stopping';
        if (server.mapUrl) { $('openMap').href = server.mapUrl; $('openMap').removeAttribute('aria-disabled'); }
        else { $('openMap').removeAttribute('href'); $('openMap').setAttribute('aria-disabled', 'true'); }
        const preset = server.preset;
        $('presetState').textContent = preset.error || `Active ${server.activePreset || 'none'} · stored ${preset.saved} · selected next start ${preset.selected}${preset.forced ? ' (environment-owned; read-only)' : ''}`;
        if (!presetDirty && preset.selected) $('preset').value = preset.selected;
        $('preset').disabled = acting || managementUncertain || preset.forced || Boolean(preset.error);
        $('savePreset').disabled = acting || managementUncertain || preset.forced || Boolean(preset.error) || !presetDirty;
        const llm = server.llm;
        $('inferenceDetails').textContent = `${llm.provider} · ${llm.model || 'no model'} · ${llm.endpoint || 'no valid endpoint'}`;
        $('inferenceState').textContent = `${llm.phase} · ${llm.message} · latency ${llm.latencyMs ?? '—'} ms · checked ${llm.checkedAt ? new Date(llm.checkedAt).toLocaleString() : 'never'}`;
        $('testInference').disabled = acting || managementUncertain || ['disabled', 'unconfigured', 'testing'].includes(llm.phase);
        const log = $('serverLog'), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        log.textContent = server.logs.length ? server.logs.map(entry => entry.line).join('\n') : 'No recent output. Full latest/previous-fallback log is available above.';
        if (atBottom) log.scrollTop = log.scrollHeight;
        $('createSave').disabled = !stopped(); $('saveName').disabled = !stopped();
        document.querySelectorAll('[data-save-action]').forEach(button => { button.disabled = !stopped(); });
        $('wipeScope').disabled = !stopped(); $('wipeConfirmation').disabled = !stopped();
        $('wipePrompt').textContent = `Type WIPE ${$('wipeScope').value.toUpperCase()}`;
        $('wipeWorld').disabled = !stopped() || $('wipeConfirmation').value !== `WIPE ${$('wipeScope').value.toUpperCase()}`;
        $('serviceInfo').textContent = `Version ${server.version} · config layers: ${server.configSources.join(' → ')}. Frontend ${location.origin}; backend listener states ${JSON.stringify(server.listeners)}; private game observer ${server.observer}.`;
        window.WorldObserverShell?.connection(server.phase === 'running' && server.observer === 'ready', server.phase === 'running' ? `Game ${server.observer}` : `Game ${server.phase}`);
    }
    async function readServerStatus() {
        const sequence = ++statusSequence;
        const next = await request('/observer/api/server/status');
        if (sequence !== statusSequence) return false;
        server = next; managementUncertain = false;
        return true;
    }
    async function refreshServer() {
        if (statusLoading || tab !== 'server') return;
        statusLoading = true;
        try {
            const previous = server;
            if (!await readServerStatus()) return;
            renderServer();
            if (previous && (previous.phase !== server.phase || previous.generation !== server.generation)) await refreshSettings({ quiet: true });
        }
        catch (error) { $('serverStatus').textContent = `Management unavailable: ${error.message}. Do not infer action completion.`; }
        finally { statusLoading = false; clearTimeout(serverTimer); if (tab === 'server') serverTimer = setTimeout(refreshServer, 2000); }
    }
    async function action(kind, payload = {}) {
        if (acting || managementUncertain) return;
        acting = true; renderServer();
        try {
            const result = await post(kind, payload);
            if (result.phase) server = result;
            message(`${kind}: response received. Inspect status and the recorded operation outcome; process exit is not proof of clean persistence.`);
            if (kind.startsWith('saves/')) await refreshSaves();
            if (kind === 'wipe') { $('wipeConfirmation').value = ''; message(`Wipe response: ${JSON.stringify(result.result)}. Permanent world changes may have occurred.`); }
            if (kind === 'start' || kind === 'stop') await refreshSettings({ quiet: true });
            return true;
        } catch (error) {
            managementUncertain = !error.status || error.status >= 500;
            message(`${kind}: ${error.message}. ${!error.status || error.status >= 500 ? 'Outcome may be uncertain; inspect ongoing/last operation before any explicit retry.' : 'No automatic retry.'}`, true);
            return false;
        } finally {
            try { await readServerStatus(); }
            catch (_) { managementUncertain = true; }
            acting = false; renderServer();
        }
    }
    $('startServer').addEventListener('click', () => action('start'));
    $('stopServer').addEventListener('click', () => action('stop'));
    $('testInference').addEventListener('click', () => action('inference-test'));
    $('preset').addEventListener('change', () => {
        if (!presetDirty) presetRevision = server?.preset.revision;
        presetDirty = $('preset').value !== server?.preset.selected; renderServer();
    });
    $('presetForm').addEventListener('submit', async event => {
        event.preventDefault(); if ($('savePreset').disabled) return;
        if (await action('progression', { revision: presetRevision, progressionRate: $('preset').value })) { presetDirty = false; await refreshSettings({ quiet: true }); renderServer(); }
    });
    async function refreshSaves() {
        if (savesLoading) return;
        savesLoading = true;
        try {
            const data = await request('/observer/api/server/saves');
            $('saveList').innerHTML = data.saves.length ? data.saves.map(save => `<div class="settings-save-item"><strong>${escape(save.name)}</strong><p>${escape(new Date(save.createdAt).toLocaleString())} · ${(save.sizeBytes / 1e9).toFixed(3)} GB</p><div class="settings-actions"><button type="button" data-save-action="load" data-save-id="${escape(save.id)}" data-save-name="${escape(save.name)}">Load</button><button type="button" data-save-action="delete" data-save-id="${escape(save.id)}" data-save-name="${escape(save.name)}">Delete</button></div></div>`).join('') : '<p>No saved games.</p>';
            $('savesMessage').textContent = 'Saved-game metadata loaded. Configuration is not part of a save.';
            renderServer();
        } catch (error) { $('savesMessage').textContent = `Saves unavailable: ${error.message}`; }
        finally { savesLoading = false; }
    }
    $('refreshSaves').addEventListener('click', refreshSaves);
    $('createSaveForm').addEventListener('submit', async event => { event.preventDefault(); if (!stopped()) return; if (await action('saves/create', { name: $('saveName').value })) $('saveName').value = ''; });
    $('saveList').addEventListener('click', event => {
        const button = event.target.closest('[data-save-action]'); if (!button || !stopped()) return;
        const operation = button.dataset.saveAction;
        if (!window.confirm(`${operation === 'load' ? 'Overwrite current world/history with' : 'Permanently delete'} “${button.dataset.saveName}”? ${operation === 'load' ? 'No automatic pre-load backup; the game remains stopped.' : 'This cannot be undone.'}`)) return;
        action(`saves/${operation}`, { id: button.dataset.saveId, confirmed: true });
    });
    $('wipeScope').addEventListener('change', () => { $('wipeConfirmation').value = ''; renderServer(); });
    $('wipeConfirmation').addEventListener('input', renderServer);
    $('wipeForm').addEventListener('submit', event => {
        event.preventDefault(); if ($('wipeWorld').disabled) return;
        if (window.confirm('Permanently delete the selected accounts, characters and related state? Includes owned vassals in bot scope.')) action('wipe', { scope: $('wipeScope').value, confirmation: $('wipeConfirmation').value });
    });
    window.WorldObserverShell?.connection(false, 'Management settings');
    refreshSettings().then(() => { if (tab === 'server') refreshSaves(); });
}());
