'use strict';

const { readJson, sendJson } = require('./SettingsRoutes');
const C = require('./GameDashboardContract');
const ACCOUNT = '/observer/api/game-account';
const DASHBOARD = '/observer/api/game-dashboard';

async function gameDashboardRoute(request, response, url, context, service) {
    if (![ACCOUNT, DASHBOARD, `${DASHBOARD}/action`].includes(url.pathname)) return false;
    try {
        if (!context?.principal) throw C.failure('authentication_required');
        const allowed = url.pathname === ACCOUNT ? ['GET', 'POST', 'DELETE'] : url.pathname === DASHBOARD ? ['GET'] : ['POST'];
        if (!allowed.includes(request.method)) {
            response.setHeader('Allow', allowed.join(', '));
            sendJson(response, { outcome: 'rejected', code: 'method_not_allowed' }, 405);
            return true;
        }
        const query = [...url.searchParams];
        if (query.length && (url.pathname !== DASHBOARD || query.length !== 1 || query[0][0] !== 'includeSkills' || query[0][1] !== '1')) throw C.failure('invalid_request');
        let result;
        if (url.pathname === ACCOUNT) {
            if (request.method === 'GET') result = service.current(context.principal);
            else if (request.method === 'DELETE') result = service.unlink(context.principal, await readJson(request));
            else result = await service.link(context.principal, context.clientAddress, await readJson(request));
        } else if (url.pathname === DASHBOARD) result = await service.read(context.principal, query.length === 1);
        else result = await service.command(context.principal, await readJson(request));
        sendJson(response, result, result.outcome === 'rejected' ? C.REASONS[result.code] || 409 : 200);
    } catch (error) {
        const code = Object.hasOwn(C.REASONS, error.code) ? error.code
            : Object.hasOwn(C.REASONS, error.message) ? error.message : 'request_failed';
        if (code === 'rate_limited') response.setHeader('Retry-After', '60');
        // Never echo IPC/database errors or submitted credentials.
        sendJson(response, { outcome: 'rejected', code }, C.REASONS[code] || error.statusCode || 500);
    }
    return true;
}

module.exports = { gameDashboardRoute };
