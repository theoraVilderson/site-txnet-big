import { SUGGESTION_NOTICE } from '@txnet-backend/shared-core';

import { AiSuggestionDeliveryJob, SUGGESTION_TEMPLATE_OF } from './ai-suggestion-delivery.job';

/**
 * F-038-g3 (ADR-0109 points 10, 11; user 2026-10-02: the worker runs the
 * loop, names and prices come from billing). Each due suggestion goes:
 * ai take → notification claim → billing names and the plan's current offer →
 * ai safety floor (last) → the notice sender → ai sent.
 *
 * The failures worth a spec: the floor run before the claim, or for a pitch
 * that then does not go (its budget spent for nothing); a plan no longer for
 * sale, or at yesterday's price, pitched anyway; a muted or too-soon one told;
 * a quiet-hours one told on the bot now; and one item's failure stopping the
 * rest of the run.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '99999999-9999-4999-8999-999999999991';
const ACTION = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-10-05T09:20:00Z');

const item = (over: Record<string, unknown> = {}) => ({
  actionId: ACTION,
  tenantId: TENANT,
  subjectKind: 'user',
  subjectId: USER,
  actionType: 'resize_down',
  label: 'suggestion',
  templateKey: 'suggestion.resize_down',
  renderedBy: 'template',
  text: null,
  grantId: GRANT,
  variantId: 'v50',
  fromVariantId: 'v100',
  price: { amount: '200000.00', currencyCode: 'IRR' },
  deadline: '2026-10-08T09:20:00.000Z',
  ...over,
});

type Answers = { claim?: unknown; plan?: unknown; floor?: unknown; items?: unknown[] };

function build(answers: Answers = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ AI_API_BASE_URL: 'http://ai', NOTIFICATION_API_BASE_URL: 'http://notification', BILLING_API_BASE_URL: 'http://billing', SERVICE_AUTH_TOKEN: 'token' })[key] ?? fallback,
  };
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ path, body });
    const data = (() => {
      if (path.endsWith('/due/take')) return { items: answers.items ?? [item()] };
      if (path.endsWith('/suggestion/claim')) return answers.claim ?? { deliver: 'now' };
      if (path.endsWith('/grants/names')) {
        return {
          items: [{ grantId: GRANT, label: 'Home', nameKey: 'catalog.p1.name', sku: 'P-100', labels: [] }],
          plans: answers.plan === undefined ? [{ variantId: 'v50', nameKey: 'catalog.v50.name', sku: 'P-50', size: '50 GB', price: { amount: '190000.00', currencyCode: 'IRR' } }] : answers.plan,
        };
      }
      if (path.endsWith('/floor')) return answers.floor ?? { pass: true };
      return {};
    })();
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) } as Response;
  });
  const sent: unknown[] = [];
  const job = new AiSuggestionDeliveryJob({} as never, {} as never, config as never, {} as never);
  (job as unknown as { sender: { send: (n: unknown) => Promise<void> } }).sender = { send: async (n) => void sent.push(n) };
  return { job, calls, sent, paths: () => calls.map((c) => c.path.replace(/[0-9a-f-]{36}/g, ':id')) };
}

afterEach(() => vi.unstubAllGlobals());

describe('AiSuggestionDeliveryJob (F-038-g3)', () => {
  it('claims, names, runs the floor last, tells inbox and bot, then marks it sent', async () => {
    const { job, paths, sent, calls } = build();
    await expect(job.run(NOW)).resolves.toMatchObject({ itemsProcessed: 1, errorsCount: 0 });
    expect(paths()).toEqual([
      '/api/internal/ai/actions/due/take',
      '/api/internal/notifications/suggestion/claim',
      '/api/internal/billing/entitlement/grants/names',
      '/api/internal/ai/actions/:id/floor',
      '/api/internal/ai/actions/:id/sent',
    ]);
    expect(calls[1].body).toEqual({ actionId: ACTION, userId: USER, grantId: GRANT });
    expect(calls[2].body).toEqual({ tenantId: TENANT, userId: USER, grantIds: [GRANT], variantIds: ['v50'] });
    expect(sent).toEqual([
      {
        consumer: 'ai-suggestion',
        eventId: ACTION,
        only: ['inbox', 'bot'],
        class: 'suggestion',
        person: {
          tenantId: TENANT,
          userId: USER,
          grantId: GRANT,
          template: 'suggestionResizeDown',
          // Today's price from billing, not the one the engine saw.
          params: {
            actionId: ACTION,
            serviceLabel: 'Home',
            serviceNameKey: 'catalog.p1.name',
            serviceSku: 'P-100',
            planNameKey: 'catalog.v50.name',
            planSku: 'P-50',
            planSize: '50 GB',
            price: '190000.00 IRR',
            days: '3',
          },
        },
      },
    ]);
  });

  it('names every action type it tells with an auth-service template', () => {
    expect(SUGGESTION_TEMPLATE_OF).toEqual({
      renew: 'suggestionRenew',
      resize_up: 'suggestionResizeUp',
      resize_down: 'suggestionResizeDown',
      top_up_wallet: 'suggestionTopUpWallet',
    });
  });

  it('tells a top-up its amount (F-038-k), and never one without it', async () => {
    const topUp = { actionType: 'top_up_wallet', templateKey: 'suggestion.top_up_wallet', amount: { amount: '400000.00', currencyCode: 'IRR' } };
    const told = build({ items: [item(topUp)] });
    await told.job.run(NOW);
    expect(told.sent).toHaveLength(1);
    expect((told.sent[0] as { person: { template: string; params: Record<string, string> } }).person).toMatchObject({
      template: 'suggestionTopUpWallet',
      params: { amount: '400000.00 IRR', price: '190000.00 IRR' },
    });

    const blank = build({ items: [item({ ...topUp, amount: null })] });
    expect(await blank.job.run(NOW)).toMatchObject({ itemsProcessed: 0, errorsCount: 1 });
    expect(blank.paths()).toEqual(['/api/internal/ai/actions/due/take']);
  });

  it('stops a muted one, and moves one a retention notice came before — no floor, nothing told', async () => {
    for (const [claim, stop] of [
      [{ deliver: 'muted' }, { tenantId: TENANT, by: 'muted' }],
      [{ deliver: 'later', reason: 'after_retention', retryAt: '2026-10-06T06:00:00.000Z' }, { tenantId: TENANT, by: 'after_retention', retryAt: '2026-10-06T06:00:00.000Z' }],
    ] as const) {
      const { job, paths, sent, calls } = build({ claim });
      await job.run(NOW);
      expect(paths()).toEqual(['/api/internal/ai/actions/due/take', '/api/internal/notifications/suggestion/claim', '/api/internal/ai/actions/:id/stop']);
      expect(calls[2].body).toEqual(stop);
      expect(sent).toEqual([]);
    }
  });

  it('never pitches a plan no longer for sale: stopped before the floor spends the budget', async () => {
    const { job, paths, sent, calls } = build({ plan: [] });
    await job.run(NOW);
    expect(paths()).not.toContain('/api/internal/ai/actions/:id/floor');
    expect(calls.at(-1)).toEqual({ path: `/api/internal/ai/actions/${ACTION}/stop`, body: { tenantId: TENANT, by: 'plan_unavailable' } });
    expect(sent).toEqual([]);
  });

  it('tells nothing when the floor refuses — ai has already moved or stopped it', async () => {
    const { job, paths, sent } = build({ floor: { pass: false, suppressedBy: 'attention_budget', rescheduledTo: '2026-10-06T00:00:00.000Z' } });
    await job.run(NOW);
    expect(paths().at(-1)).toBe('/api/internal/ai/actions/:id/floor');
    expect(sent).toEqual([]);
  });

  it('inside quiet hours: the inbox now, the bot kept on the ledger for the window end', async () => {
    const { job, sent, calls } = build({ claim: { deliver: 'held', botAt: '2026-10-05T10:30:00.000Z' } });
    await job.run(NOW);
    expect(sent).toEqual([expect.objectContaining({ only: ['inbox'], eventId: ACTION })]);
    const hold = calls.find((c) => c.path.endsWith('/retention/hold'));
    expect(hold?.body).toEqual(
      expect.objectContaining({ eventId: ACTION, grantId: GRANT, notice: SUGGESTION_NOTICE, period: ACTION, tenantId: TENANT, template: 'suggestionResizeDown', botAt: '2026-10-05T10:30:00.000Z' }),
    );
    expect(calls.at(-1)?.path).toBe(`/api/internal/ai/actions/${ACTION}/sent`);
  });

  it('one item failing does not stop the others; it is counted', async () => {
    const other = '77777777-7777-4777-8777-777777777778';
    const { job } = build({ items: [item({ grantId: null }), item({ actionId: other })] });
    await expect(job.run(NOW)).resolves.toMatchObject({ itemsProcessed: 1, errorsCount: 1 });
  });
});
