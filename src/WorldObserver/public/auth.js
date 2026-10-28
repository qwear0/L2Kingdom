(function observerAuthentication(root) {
    'use strict';
    const API = '/observer/api/auth/';
    const originalFetch = root.fetch.bind(root);
    const signIn = () => location.replace(`/observer/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    root.fetch = async (input, options) => {
        const response = await originalFetch(input, options);
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        if (response.status === 401 && url.origin === location.origin && url.pathname.startsWith('/observer/') && !url.pathname.startsWith(API)) signIn();
        return response;
    };
    root.WorldObserverAuth = {
        async logout() {
            const response = await originalFetch(`${API}logout`, { method: 'POST' });
            if (!response.ok) throw new Error('Sign out failed. Try again.');
            location.replace('/observer/login');
        },
        async user() {
            const response = await originalFetch(`${API}session`);
            if (response.status === 401) { signIn(); return null; }
            if (response.status === 404) throw new Error('Sign-in unavailable. Restart the management process.');
            if (!response.ok) throw new Error('Session could not load.');
            return (await response.json()).user;
        }
    };
    const form = document.getElementById('observerLogin');
    if (!form) return;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button'), input = form.elements.key;
        const message = document.getElementById('loginMessage');
        if (button.disabled) return;
        button.disabled = true; input.readOnly = true; message.textContent = '';
        form.setAttribute('aria-busy', 'true');
        try {
            const response = await originalFetch(`${API}login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: input.value.trim() }) });
            if (response.status === 404) throw new Error('Sign-in unavailable. Restart the management process.');
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Sign in failed.');
            input.value = '';
            const next = new URLSearchParams(location.search).get('next') || '/observer/';
            const target = new URL(next, location.origin);
            location.replace(target.origin === location.origin && target.pathname.startsWith('/observer/') && !/^\/observer\/login\/?$/.test(target.pathname) ? target.href : '/observer/');
        } catch (error) { message.textContent = error.message; }
        finally { button.disabled = false; input.readOnly = false; form.removeAttribute('aria-busy'); }
    });
})(window);
