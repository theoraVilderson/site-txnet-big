/**
 * Every route an impersonated token may reach (AC-1-g, ADR-0136, catalog §3.6
 * layer 4). An allowlist: a route nobody listed is closed.
 *
 * A copy of `contracts/http/impersonation.json`, pinned to it by
 * `impersonation.spec.ts`; edit the fixture first. auth-handler holds the same
 * copy for every gated router; auth-service is not behind the gate, so its
 * `AuthGuard` asks this one for the `/api/auth` rows.
 */
export interface ImpersonationRoute {
  method: string;
  /** The public path; a `:name` segment matches any one non-empty segment. */
  path: string;
  socket?: true;
}

export const IMPERSONATION_REACH: readonly ImpersonationRoute[] = [
  { method: 'GET', path: '/api/auth/me' },
  { method: 'GET', path: '/api/auth/me/messenger' },
  { method: 'GET', path: '/api/auth/me/timezone' },
  { method: 'PUT', path: '/api/auth/me/timezone' },
  { method: 'PUT', path: '/api/auth/me/name' },
  { method: 'GET', path: '/api/auth/me/ui-preferences' },
  { method: 'PATCH', path: '/api/auth/me/ui-preferences' },
  { method: 'POST', path: '/api/auth/impersonate/end' },
  { method: 'GET', path: '/api/ai/me/suggestion' },
  { method: 'POST', path: '/api/ai/me/suggestion/:actionId/dismiss' },
  { method: 'POST', path: '/api/ai/me/suggestion/:actionId/opt-out' },
  { method: 'GET', path: '/api/billing/offers' },
  { method: 'POST', path: '/api/billing/invoices' },
  { method: 'GET', path: '/api/billing/invoices/:id' },
  { method: 'POST', path: '/api/billing/invoices/:id/pay' },
  { method: 'POST', path: '/api/billing/invoices/:id/cancel' },
  { method: 'POST', path: '/api/billing/gift/redeem' },
  { method: 'GET', path: '/api/billing/gift/grants' },
  { method: 'PUT', path: '/api/billing/gift/grants/:grantId/label' },
  { method: 'GET', path: '/api/billing/traffic/grants/:grantId/usage' },
  { method: 'GET', path: '/api/billing/traffic/grants/:grantId/period' },
  { method: 'PUT', path: '/api/billing/traffic/configs/:configId/label' },
  { method: 'GET', path: '/api/billing/traffic/grants/:grantId/cap' },
  { method: 'PUT', path: '/api/billing/traffic/grants/:grantId/cap' },
  { method: 'DELETE', path: '/api/billing/traffic/grants/:grantId/cap' },
  { method: 'GET', path: '/api/billing/wallet/history' },
  { method: 'GET', path: '/api/billing/wallet/payments' },
  { method: 'GET', path: '/api/billing/wallet/payments/:id' },
  { method: 'GET', path: '/api/billing/lotteries' },
  { method: 'GET', path: '/api/billing/lotteries/:id/result' },
  { method: 'POST', path: '/api/billing/lotteries/:id/entry' },
  { method: 'DELETE', path: '/api/billing/lotteries/:id/entry' },
  { method: 'GET', path: '/api/billing/wheel' },
  { method: 'GET', path: '/api/billing/wheel/history' },
  { method: 'POST', path: '/api/billing/wheel/spin' },
  { method: 'GET', path: '/api/currency/rates' },
  { method: 'GET', path: '/api/notifications' },
  { method: 'POST', path: '/api/notifications/read' },
  { method: 'GET', path: '/api/notifications/preferences' },
  { method: 'PUT', path: '/api/notifications/preferences' },
  { method: 'GET', path: '/api/notifications/preferences/grants' },
  { method: 'PUT', path: '/api/notifications/preferences/grants/:grantId' },
  { method: 'GET', path: '/api/support/categories' },
  { method: 'GET', path: '/api/support/availability' },
  { method: 'GET', path: '/api/support/conversations' },
  { method: 'POST', path: '/api/support/conversations' },
  { method: 'GET', path: '/api/support/conversations/counts' },
  { method: 'GET', path: '/api/support/conversations/:id/messages' },
  { method: 'POST', path: '/api/support/conversations/:id/messages' },
  { method: 'POST', path: '/api/support/conversations/:id/attachments' },
  { method: 'GET', path: '/api/support/conversations/:id/attachments/:attachmentId' },
  { method: 'POST', path: '/api/support/conversations/:id/typing' },
  { method: 'POST', path: '/api/support/conversations/:id/read' },
  { method: 'POST', path: '/api/support/conversations/:id/rating' },
  { method: 'POST', path: '/api/support/conversations/:id/reopen' },
  { method: 'GET', path: '/api/tenants/purchase/packages' },
  { method: 'GET', path: '/api/tenants/purchase/mine' },
  { method: 'GET', path: '/api/tenants/purchase/slug' },
  { method: 'GET', path: '/api/guides/feedback/:key' },
  { method: 'PUT', path: '/api/guides/feedback/:key' },
  { method: 'GET', path: '/realtime', socket: true },
];

/** `error.reason` of the refusal: refreshing will not change it. */
export const IMPERSONATION_BLOCKED_REASON = 'impersonationBlocked';

/**
 * May an impersonated token make this request? The query is dropped; a path
 * not already in its cleaned form (`..`, `%`-encoding, `//`, a trailing `/`)
 * is refused rather than resolved — the rule auth-handler applies.
 */
export function impersonationMayReach(method: string, url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  if (!method || !path.startsWith('/') || path.includes('%')) return false;
  const got = path.split('/');
  if (got.slice(1).some((s) => s === '' || s === '.' || s === '..')) return false;
  return IMPERSONATION_REACH.some((r) => {
    if (r.method !== method) return false;
    const want = r.path.split('/');
    return want.length === got.length && want.every((w, i) => (w.startsWith(':') ? got[i] !== '' : w === got[i]));
  });
}
