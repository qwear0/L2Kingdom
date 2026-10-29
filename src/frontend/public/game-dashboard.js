(function gameDashboard() {
    'use strict';
    const $ = id => document.getElementById(id);
    const PAGE_SIZE = 8, thresholdKeys = ['hpEnter', 'hpResume', 'mpEnter', 'mpResume'];
    const pending = { autoFight: null, party: null }, awaiting = { autoFight: false, party: false };
    const feedback = { autoFight: '', party: '' }, drafts = { radius: null, thresholds: null };
    let snapshot = null, contextKey = null, view = 'hunt', skills = null, skillsKey = null, skillsPage = 0;
    let icons = null, iconsLoading = false, iconsError = '', readController = null, reading = false, readAgain = false;
    let timer = null, epoch = 0, active = true, delay = 2000;
    const reasons = {
        unlinked: 'Link an existing game account in Settings to use these controls.',
        offline: 'No connected real-player character on the linked account.',
        ambiguous_session: 'Multiple online sessions match the account. No character was selected; resolve the ambiguity in-game.',
        unavailable: 'The game runtime is unavailable. No offline character was invented.',
        dashboard_not_ready: 'Gameplay Dashboard support (P2) is not implemented in the running revision.',
        runtime_unavailable: 'The game is not running or the runtime connection is unavailable.',
        runtime_timeout: 'The runtime response timed out. An admitted action may still have executed.',
        stale_link: 'The account association changed. Review the current character before another action.',
        stale_actor: 'The character session changed. Refresh and review the new context.',
        stale_version: 'The card changed in-game or in another browser. Draft retained; review accepted values before an explicit resubmission.',
        stale_run: 'That hunt ended or was replaced. This Stop did not target the replacement run.',
        stop_required: 'Stop the current hunt before structural edits.',
        not_running: 'No hunt is running.', missing_points: 'Set both the hunt center and rest point first.',
        points_too_far: 'The center, rest point or current position is outside the permitted setup distance.',
        settling: 'A previous control operation is still settling.', dead: 'This member is dead.', teleporting: 'This member is already teleporting.',
        role_restricted: 'This role cannot be assigned pull duty.', membership_changed: 'Party membership changed before this member could be affected.',
        settings_loading: 'Preferences are still loading.', settings_failed: 'Preferences failed to load or save. Use the explicit recovery controls.',
        action_unavailable: 'This action is unavailable in the current state.', invalid_member: 'That member is no longer in the authoritative party.',
        invalid_skill: 'The skill is no longer eligible.', supply_errand: 'Hidden supply errand; this member was not moved.',
        busy: 'Another operation is settling. No request was queued.', rate_limited: 'Too many requests; wait before an explicit retry.',
        invalid_request: 'The request did not match the gameplay contract.', authentication_required: 'Sign in again.'
    };
    const explain = code => reasons[code] || String(code || 'Unavailable');
    const text = (id, value) => { const node = $(id), next = String(value ?? 'Unavailable'); if (node.textContent !== next) node.textContent = next; };
    const online = () => snapshot?.availability === 'online' && snapshot.context?.linkRevision && snapshot.context?.actorToken;
    const point = value => value ? `${value.locX}, ${value.locY}, ${value.locZ}` : 'Not set';
    const onOff = value => typeof value === 'boolean' ? value ? 'On' : 'Off' : 'Unavailable';
    function capability(action, subject) {
        const card = action.split('.')[0];
        if (!online()) return { enabled: false, reason: 'Controls require one online linked character.' };
        if (pending[card]) return { enabled: false, reason: 'Waiting for this card’s command response…' };
        if (awaiting[card]) return { enabled: false, reason: 'Refresh required before another action; previous outcome may be uncertain.' };
        const state = snapshot[card];
        if (!state?.version || (action === 'autoFight.stop' && !state.runId)) return { enabled: false, reason: 'No current card / hunt token.' };
        let value = subject ? subject.capabilities?.[action] : state.capabilities?.[action];
        if (action === 'autoFight.setSkillAllowed' && subject) {
            const removing = state.allowedSkillIds.includes(subject.id);
            value = state.capabilities?.[action];
            // Row eligibility is cached; run/load/selection restrictions come from
            // each ordinary snapshot, so stale row flags cannot enable an addition.
            if (!removing && (state.runId || subject.available !== true || state.allowedSkillIds.length >= 512)) {
                return { enabled: false, reason: state.runId ? explain('stop_required') : 'Skill unavailable or whitelist at capacity.' };
            }
        }
        return value?.enabled === true ? value : { enabled: false, reason: explain(value?.reason || 'action_unavailable') };
    }
    function updateButton(button, subject) {
        const cap = capability(button.dataset.action, subject);
        button.disabled = !cap.enabled;
        button.title = cap.enabled ? '' : cap.reason;
        if (button.dataset.value !== undefined && snapshot?.party) {
            const key = { 'party.setMovement': 'movement', 'party.setCombat': 'combat', 'party.setPull': 'pull' }[button.dataset.action];
            if (key) button.setAttribute('aria-pressed', String(snapshot.party.settings?.[{ movement: 'movementMode', combat: 'combatMode', pull: 'pullMode' }[key]] === button.dataset.value));
        }
    }
    function resetDrafts(notice) {
        const hadDraft = drafts.radius || drafts.thresholds;
        drafts.radius = drafts.thresholds = null;
        for (const id of ['huntRadius', ...thresholdKeys]) $(id).value = '';
        if (hadDraft) { text('dashboardDraftNotice', notice); $('dashboardDraftNotice').hidden = false; }
    }
    function accept(data, includeSkills) {
        const key = data.availability === 'online' ? `${data.context?.linkRevision}:${data.context?.actorToken}` : null;
        if (data.availability === 'online' && (!data.context?.linkRevision || !data.context?.actorToken || !data.autoFight?.version || !data.party?.version)) {
            throw new Error('Incomplete online snapshot. Controls remain disabled until the matching P2 contract is available.');
        }
        if (key && (!Array.isArray(data.party.members) || data.party.members.length > 8
            || data.party.members.some(member => !Number.isInteger(member.id) || member.id < 1)
            || new Set(data.party.members.map(member => member.id)).size !== data.party.members.length
            || !Array.isArray(data.autoFight.allowedSkillIds) || data.autoFight.allowedSkillIds.length > 512)) {
            throw new Error('Invalid bounded roster or skill preferences. No controls enabled.');
        }
        if (key && key !== contextKey) {
            resetDrafts('The linked character changed. Old character drafts were discarded, not submitted.');
            skills = null; skillsKey = null; skillsPage = 0;
            for (const id of ['huntRadius', ...thresholdKeys]) $(id).value = data.autoFight[id === 'huntRadius' ? 'radius' : id] ?? '';
            feedback.autoFight = feedback.party = '';
        } else if (['unlinked', 'offline', 'ambiguous_session'].includes(data.availability)) {
            resetDrafts('The character is no longer uniquely available. Old drafts were discarded, not submitted.');
            skills = null; skillsKey = null;
        }
        if (key || ['unlinked', 'offline', 'ambiguous_session'].includes(data.availability)) contextKey = key;
        snapshot = data;
        if (key && includeSkills && Array.isArray(data.autoFight.skills)) {
            if (data.autoFight.skills.length > 1024 || data.autoFight.skills.some(skill => !Number.isInteger(skill.id) || skill.id < 1 || skill.id > 65535)
                || new Set(data.autoFight.skills.map(skill => skill.id)).size !== data.autoFight.skills.length) throw new Error('Invalid bounded skill catalog.');
            skills = data.autoFight.skills;
            skillsKey = `${key}:${data.autoFight.skillsRevision}`;
        }
        awaiting.autoFight = awaiting.party = false;
        delay = ['online', 'offline'].includes(data.availability) ? 2000 : data.availability === 'unlinked' ? 10000 : 8000;
    }
    function schedule() {
        clearTimeout(timer);
        if (active && !document.hidden) timer = setTimeout(refresh, delay);
    }
    async function refresh() {
        if (!active || document.hidden) return;
        clearTimeout(timer);
        if (reading) { readAgain = true; return; }
        reading = true; readAgain = false;
        const own = epoch;
        const includeSkills = view === 'skills' && (!online() || skillsKey !== `${contextKey}:${snapshot.autoFight.skillsRevision}`);
        readController = new AbortController();
        const deadline = setTimeout(() => readController?.abort(), 8000);
        $('refreshDashboard').disabled = true;
        try {
            const response = await fetch(`/observer/api/game-dashboard${includeSkills ? '?includeSkills=1' : ''}`, { cache: 'no-store', signal: readController.signal });
            const data = await response.json();
            if (own !== epoch || !active || document.hidden) return;
            if (!response.ok) throw new Error(explain(data.code || `HTTP ${response.status}`));
            accept(data, includeSkills);
            render();
            if (view === 'skills' && online() && skillsKey !== `${contextKey}:${snapshot.autoFight.skillsRevision}` && !includeSkills) readAgain = true;
        } catch (error) {
            if (own !== epoch || !active || document.hidden) return;
            snapshot = null; delay = Math.min(15000, Math.max(4000, delay * 2));
            render(); text('dashboardAvailability', `State unavailable: ${error.message}. No automatic command retry; drafts are retained for the same context.`);
        } finally {
            clearTimeout(deadline); reading = false; readController = null;
            $('refreshDashboard').disabled = false;
            if (active && !document.hidden) { if (readAgain) { readAgain = false; refresh(); } else schedule(); }
        }
    }
    function invalidateRead() {
        ++epoch; clearTimeout(timer); readController?.abort();
    }
    function resultMessage(result) {
        if (!['applied', 'partial'].includes(result.outcome)) throw new Error(explain(result.code || 'Unrecognized command outcome'));
        let message = result.outcome === 'partial' ? 'Partially applied.' : 'Applied to gameplay.';
        if (result.affectedMemberIds) message += ` Affected: ${result.affectedMemberIds.join(', ') || 'none'}.`;
        if (result.skippedMembers) message += ` Skipped: ${result.skippedMembers.map(member => `#${member.id}: ${explain(member.reason)}`).join('; ') || 'none'}.`;
        if (result.preemptedMemberIds) message += ` Preempted MCP activity: ${result.preemptedMemberIds.join(', ') || 'none'}.`;
        if (result.persistence) message += ` Preference persistence: ${result.persistence.status}; applied does not imply saved.`;
        return message;
    }
    async function command(action, values = {}, draftName = null, subject = null) {
        const card = action.split('.')[0];
        if (!capability(action, subject).enabled) return;
        const bound = { ...snapshot.context }, key = contextKey, state = snapshot[card];
        const draft = draftName ? drafts[draftName] : null;
        const fence = action === 'autoFight.stop' ? { expectedRunId: state.runId } : { expectedVersion: draft?.version || state.version };
        const payload = { context: bound, action, ...fence, ...values };
        const operation = { action, ...values }; pending[card] = operation;
        feedback[card] = 'Waiting for command response…'; invalidateRead(); render();
        const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch('/observer/api/game-dashboard/action', { method: 'POST', cache: 'no-store', signal: controller.signal,
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const result = await response.json();
            if (!active || contextKey !== key) return;
            if (!response.ok) throw new Error(`${explain(result.code || `HTTP ${response.status}`)} No automatic retry.`);
            feedback[card] = resultMessage(result);
            if (draftName && drafts[draftName] === draft) drafts[draftName] = null;
        } catch (error) {
            if (active && contextKey === key) feedback[card] = `${error.message} Review refreshed authoritative values before another explicit action. A network failure or timeout is not proof of non-execution.`;
        } finally {
            clearTimeout(deadline);
            if (pending[card] === operation) {
                pending[card] = null; awaiting[card] = true;
                invalidateRead(); render(); refresh();
            }
        }
    }
    function renderDraft(name, ids, action) {
        const af = online() ? snapshot.autoFight : null, draft = drafts[name];
        for (const id of ids) {
            const key = id === 'huntRadius' ? 'radius' : id;
            const input = $(id);
            // Status polling never replaces focused numeric controls or their local values/caret.
            const value = String(draft ? draft.values[key] : af?.[key] ?? '');
            if (input.value !== value && (draft || document.activeElement !== input)) input.value = value;
            input.disabled = !af || Boolean(pending.autoFight) || !capability(action).enabled;
        }
        const button = $(name === 'radius' ? 'radiusForm' : 'thresholdForm').querySelector('[type="submit"]');
        updateButton(button);
        if (draft && af && draft.version !== af.version) button.title = 'Draft retained from an older version. Submission is fenced and may conflict; explicitly rebase or use accepted values.';
        const rebase = document.querySelector(`[data-rebase="${name}"]`);
        rebase.hidden = !draft || !af || draft.version === af.version;
        rebase.disabled = !af || Boolean(pending.autoFight) || awaiting.autoFight;
        document.querySelector(`[data-discard="${name}"]`).disabled = !af || Boolean(pending.autoFight);
    }
    function render() {
        const ready = online(), af = ready ? snapshot.autoFight : null, party = ready ? snapshot.party : null;
        const availability = snapshot?.availability || 'unavailable';
        text('dashboardCharacter', ready ? snapshot.character?.name || 'Connected character' : snapshot?.accountName ? `Linked account: ${snapshot.accountName}` : 'No controllable character');
        text('dashboardAvailability', ready ? 'Connected character resolved. Changes are checked again by gameplay.' : explain(snapshot?.code || availability));
        $('dashboardLink').hidden = availability !== 'unlinked';
        window.WorldObserverShell.connection(Boolean(ready), ready ? 'Game Dashboard' : 'Game unavailable');
        text('autoFightRun', af ? af.runId ? 'Hunt active' : 'Stopped / setup' : 'Unavailable');
        text('autoFightPersistence', af ? `Preferences: ${af.settingsStatus} · persistence: ${af.settingsSave}${af.settingsError ? ` · ${af.settingsError}` : ''}.` : 'Preferences unavailable.');
        text('autoFightFeedback', feedback.autoFight); text('partyFeedback', feedback.party);
        for (const card of ['autoFight', 'party']) {
            $(card + 'Card').setAttribute('aria-busy', String(Boolean(pending[card])));
            const disabled = !ready ? 'Controls require one online linked character.' : pending[card] ? 'Waiting for this card’s command response…' : awaiting[card] ? 'Waiting for fresh authoritative state; do not replay the previous command.'
                : [...new Set(Object.values(snapshot[card].capabilities || {}).filter(cap => !cap.enabled && cap.reason).map(cap => explain(cap.reason)))].join(' · ');
            text(card + 'Disabled', disabled || 'Available actions are enabled below.');
        }
        text('huntReason', af?.reason); text('huntState', af ? `${af.state || 'Stopped / setup'} · recovery ${onOff(af.recovery)}` : null);
        text('huntTarget', af ? af.targetId ?? 'Not projected by gameplay' : null); text('huntCenter', af ? point(af.center) : 'Unavailable'); text('huntPoint', af ? point(af.restPoint) : 'Unavailable');
        text('radiusAccepted', `Accepted: ${af?.radius ?? 'unavailable'}${drafts.radius ? ' · local draft retained' : ''}`);
        text('thresholdAccepted', af ? `Accepted HP ${af.hpEnter}/${af.hpResume}% · MP ${af.mpEnter}/${af.mpResume}%${drafts.thresholds ? ' · local draft retained' : ''}` : 'Accepted: unavailable');
        text('basicAccepted', onOff(af?.basicAttackOnly)); text('pickupAccepted', onOff(af?.pickup));
        text('partyCount', party ? `${party.members.length} companions` : 'Unavailable');
        for (const [mode, key] of [['movement', 'movementMode'], ['combat', 'combatMode'], ['pull', 'pullMode']]) text(mode + 'Accepted', party?.settings?.[key]);
        text('lootAccepted', onOff(party?.settings?.lootPickupEnabled));
        document.querySelectorAll('[data-action]:not([data-member]):not([data-skill])').forEach(button => updateButton(button));
        for (const [action, value] of [['autoFight.setBasicAttackOnly', af?.basicAttackOnly], ['autoFight.setPickup', af?.pickup], ['party.setLoot', party?.settings?.lootPickupEnabled]]) {
            const button = document.querySelector(`[data-action="${action}"]`);
            button.textContent = typeof value === 'boolean' ? `Turn ${value ? 'off' : 'on'}` : 'Unavailable';
            if (typeof value !== 'boolean') button.disabled = true;
        }
        renderDraft('radius', ['huntRadius'], 'autoFight.setRadius'); renderDraft('thresholds', thresholdKeys, 'autoFight.setThresholds');
        renderMembers(party?.members || []); renderSkills();
    }
    function renderMembers(members) {
        const container = $('partyMembers'), current = new Map([...container.querySelectorAll('[data-member-row]')].map(row => [Number(row.dataset.memberRow), row]));
        container.querySelector(':scope > p')?.remove();
        if (!members.length) { const p = document.createElement('p'); p.textContent = online() ? 'No active companions in this party.' : 'No roster available.'; container.append(p); }
        for (const [index, member] of members.entries()) {
            let row = current.get(member.id);
            if (!row) {
                row = document.createElement('section'); row.className = 'dashboard-member'; row.dataset.memberRow = member.id;
                row.innerHTML = `<h3></h3><p></p><div class="dashboard-actions">${[['follow', 'Follow'], ['stay', 'Stay'], ['call', 'Call'], ['setMemberPull', 'Assign pull']].map(([action, label]) => `<button type="button" data-action="party.${action}" data-member="${Number(member.id)}">${label}</button>`).join('')}</div><small></small>`;
            }
            const heading = `${member.name} · Lv ${member.level ?? '?'} · ${member.className || `Class #${member.classId ?? '?'}`} · ${member.role || 'Role unavailable'}`;
            if (row.querySelector('h3').textContent !== heading) row.querySelector('h3').textContent = heading;
            row.querySelector('p').textContent = `${member.dead ? 'Dead' : member.supplyErrand ? 'Supply errand' : member.online ? 'Online' : 'Not visible online'} · ${member.holding ? 'Holding' : 'Following'} · target ${member.targetId ?? 'none'} · ${member.control?.mode || 'Control unavailable'}${member.decision ? ` · ${member.decision.action}: ${member.decision.reason}` : ''}`;
            row.querySelectorAll('[data-action]').forEach(button => { updateButton(button, member); if (button.dataset.action === 'party.setMemberPull') button.textContent = member.isPuller ? 'Stop assigned pull' : 'Assign pull'; });
            row.querySelector('small').textContent = [...new Set(Object.values(member.capabilities || {}).filter(cap => !cap.enabled && cap.reason).map(cap => explain(cap.reason)))].join(' · ');
            if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
            current.delete(member.id);
        }
        for (const row of current.values()) row.remove();
    }
    async function loadIcons() {
        if (icons || iconsLoading) return;
        iconsLoading = true; iconsError = '';
        const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetch('/observer/skill-icons.json', { signal: controller.signal, cache: 'no-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.size !== 32 || data.width !== 1024 || data.height !== 640 || !data.skills) throw new Error('Icon catalog does not match the shipped atlas.');
            icons = data;
        } catch (error) { iconsError = `Native skill images unavailable: ${error.message}. Refresh or reopen Skills to retry.`; }
        finally { clearTimeout(deadline); iconsLoading = false; if (active) renderSkills(); }
    }
    function renderSkills() {
        if (view !== 'skills') return;
        const expected = online() ? `${contextKey}:${snapshot.autoFight.skillsRevision}` : null;
        const available = expected && expected === skillsKey && skills;
        text('skillsStatus', !online() ? 'Skills require one online linked character.' : !available ? 'Loading eligible learned skills…' : iconsError || `Allowed skills: ${snapshot.autoFight.allowedSkillIds?.length ?? 'unavailable'} · basic-only ${onOff(snapshot.autoFight.basicAttackOnly)}.${iconsLoading ? ' Loading native images…' : ''}`);
        const allowed = new Set(snapshot?.autoFight?.allowedSkillIds || []);
        const rows = available ? skills.filter(skill => skill.available === true || allowed.has(skill.id)) : [];
        const listed = new Set(rows.map(skill => skill.id));
        if (available) for (const id of allowed) if (!listed.has(id)) rows.push({ id, name: `Unavailable saved skill #${id}`, available: false, icon: null });
        rows.sort((left, right) => left.id - right.id);
        const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        if (available) skillsPage = Math.min(skillsPage, pages - 1);
        text('skillsPage', available ? `Page ${skillsPage + 1} / ${pages}` : `Page ${skillsPage + 1} · awaiting catalog`);
        $('skillsPrevious').disabled = !available || skillsPage === 0; $('skillsNext').disabled = !available || skillsPage + 1 >= pages;
        const container = $('skillList'), current = new Map([...container.children].map(row => [Number(row.dataset.skillRow), row]));
        for (const [index, skill] of rows.slice(skillsPage * PAGE_SIZE, (skillsPage + 1) * PAGE_SIZE).entries()) {
            let row = current.get(skill.id);
            if (!row) {
                row = document.createElement('div'); row.className = 'dashboard-skill'; row.dataset.skillRow = skill.id;
                row.innerHTML = `<span class="dashboard-skill-icon" aria-hidden="true" hidden></span><div><strong></strong><small></small></div><button type="button" data-action="autoFight.setSkillAllowed" data-skill="${Number(skill.id)}"></button>`;
            }
            row.querySelector('strong').textContent = skill.name;
            const coords = icons?.skills[String(skill.id)];
            const hasIcon = skill.available === true && skill.icon === `icon.skill${String(skill.id).padStart(4, '0')}` && Array.isArray(coords) && coords.length === 2 && coords.every(Number.isInteger) && coords[0] >= 0 && coords[1] >= 0 && coords[0] + 32 <= icons.width && coords[1] + 32 <= icons.height;
            const image = row.querySelector('.dashboard-skill-icon'); image.hidden = !hasIcon;
            if (hasIcon) image.style.backgroundPosition = `-${coords[0]}px -${coords[1]}px`;
            const button = row.querySelector('button'); button.textContent = `${allowed.has(skill.id) ? 'Remove' : 'Allow'}${pending.autoFight?.skillId === skill.id ? ' (waiting)' : ''}`;
            updateButton(button, skill);
            row.querySelector('small').textContent = `#${skill.id}${skill.available !== true ? ' · unavailable saved skill (removal only)' : ''}${!hasIcon ? ' · native image unavailable' : ''}${button.disabled ? ` · ${button.title}` : ''}`;
            if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
            current.delete(skill.id);
        }
        for (const row of current.values()) row.remove();
        if (available && !rows.length) text('skillsStatus', 'No eligible learned or saved skills.');
    }
    function captureDraft(name, ids) {
        if (!online() || pending.autoFight) return;
        const previous = drafts[name];
        drafts[name] = { version: previous?.version || snapshot.autoFight.version, values: Object.fromEntries(ids.map(id => [id === 'huntRadius' ? 'radius' : id, $(id).value])) };
        $('dashboardDraftNotice').hidden = true;
    }
    $('radiusForm').addEventListener('focusin', event => { if (event.target.matches('input') && !drafts.radius) captureDraft('radius', ['huntRadius']); });
    $('thresholdForm').addEventListener('focusin', event => { if (event.target.matches('input') && !drafts.thresholds) captureDraft('thresholds', thresholdKeys); });
    $('radiusForm').addEventListener('input', () => captureDraft('radius', ['huntRadius']));
    $('thresholdForm').addEventListener('input', () => captureDraft('thresholds', thresholdKeys));
    $('radiusForm').addEventListener('submit', event => {
        event.preventDefault(); const value = Number($('huntRadius').value);
        if (!Number.isInteger(value) || value < 1 || value > 6000) return;
        command('autoFight.setRadius', { value }, 'radius');
    });
    $('thresholdForm').addEventListener('submit', event => {
        event.preventDefault(); const values = Object.fromEntries(thresholdKeys.map(key => [key, Number($(key).value)]));
        if (Object.values(values).some(value => !Number.isInteger(value) || value < 1 || value > 100) || values.hpEnter >= values.hpResume || values.mpEnter >= values.mpResume) {
            feedback.autoFight = 'Enter four integer percentages with enter below resume for both HP and MP.'; render(); return;
        }
        command('autoFight.setThresholds', values, 'thresholds');
    });
    document.querySelector('.game-dashboard').addEventListener('click', event => {
        const rebase = event.target.closest('[data-rebase]');
        if (rebase && !rebase.disabled && online()) {
            const draft = drafts[rebase.dataset.rebase];
            if (draft) drafts[rebase.dataset.rebase] = { ...draft, version: snapshot.autoFight.version };
            render(); return;
        }
        const discard = event.target.closest('[data-discard]');
        if (discard && !discard.disabled) { drafts[discard.dataset.discard] = null; render(); return; }
        const tab = event.target.closest('[data-view]');
        if (tab) {
            view = tab.dataset.view;
            $('huntView').hidden = view !== 'hunt'; $('skillsView').hidden = view !== 'skills'; $('fightSettingsView').hidden = view !== 'settings';
            document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button === tab)));
            if (view === 'skills') { renderSkills(); loadIcons(); refresh(); }
            return;
        }
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled || button.type === 'submit' || !online()) return;
        const action = button.dataset.action;
        let values = {}, subject = null;
        if (button.dataset.member) {
            const memberId = Number(button.dataset.member); subject = snapshot.party.members.find(member => member.id === memberId);
            if (!subject) return;
            values = { memberId, ...(action === 'party.setMemberPull' ? { value: !subject.isPuller } : {}) };
        } else if (button.dataset.skill) {
            const skillId = Number(button.dataset.skill); subject = skills?.find(skill => skill.id === skillId);
            if (!subject && snapshot.autoFight.allowedSkillIds.includes(skillId)) subject = { id: skillId, available: false };
            if (!subject || skillsKey !== `${contextKey}:${snapshot.autoFight.skillsRevision}`) return;
            values = { skillId, value: !snapshot.autoFight.allowedSkillIds.includes(skillId) };
        } else if (button.dataset.value !== undefined) values = { value: button.dataset.value };
        else if (action === 'autoFight.setBasicAttackOnly') values = { value: !snapshot.autoFight.basicAttackOnly };
        else if (action === 'autoFight.setPickup') values = { value: !snapshot.autoFight.pickup };
        else if (action === 'party.setLoot') values = { value: !snapshot.party.settings.lootPickupEnabled };
        if (['autoFight.newSession', 'autoFight.resetDefaults'].includes(action) && !window.confirm(action === 'autoFight.newSession' ? 'Clear both transient hunt points?' : 'Replace saved preferences with defaults and clear the skill whitelist?')) return;
        command(action, values, null, subject);
    });
    $('skillsPrevious').addEventListener('click', () => { skillsPage = Math.max(0, skillsPage - 1); renderSkills(); });
    $('skillsNext').addEventListener('click', () => { ++skillsPage; renderSkills(); });
    $('refreshDashboard').addEventListener('click', () => { if (view === 'skills') loadIcons(); refresh(); });
    document.addEventListener('visibilitychange', () => {
        invalidateRead(); snapshot = null; render();
        if (!document.hidden) refresh();
    });
    window.addEventListener('pagehide', () => { active = false; invalidateRead(); });
    window.addEventListener('pageshow', event => { if (event.persisted) { active = true; snapshot = null; render(); refresh(); } });
    render(); refresh();
}());
