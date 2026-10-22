import type { Mocked } from 'vitest';
import { aBotIntegration, BotText } from '@txnet-backend/messenger';
import { renewalOpenCallback } from '@txnet-backend/shared-core';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import type { RenewalInvoice, RenewalPlans } from '../billing-api/renewal.types';
import type { MyService } from '../billing-api/services.types';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { LocaleService } from '../locale/locale.service';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { renewalAction, renewalOffered } from './renewal-actions';
import { RenewalFlow } from './renewal.flow';
import { serviceAction } from './services.flow';
import { ACTIONS } from './views';

/**
 * «تمدید» in the chat (F-305-i): the panel's renewal (billing
 * `contract.renewal.md`) through the gate, paid from the wallet (user,
 * 2026-10-22: no in-chat gateway — a shortfall goes to the top-up). The bot
 * decides nothing. What would break silently here:
 *  - **a plan billing would refuse offered**, or a figure computed in the chat
 *    — the plans and every price are billing's answers;
 *  - **a button that cannot be sent** — a callback is at most 64 bytes, and
 *    the notice's button (shared-core) must be the one this flow reads;
 *  - **a dead end on a short wallet** — the shortfall says how much and leads
 *    to the top-up, and the same invoice can be paid after it.
 */
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const refused = (msg: string, reason?: string, facts?: Record<string, string>) => ({ ok: false, msg, error: { reason, facts } });
const NOW = new Date('2026-10-22T12:00:00Z');
const GRANT = '0f0e0d0c-0b0a-4908-8706-050403020100';
const INVOICE = '1f1e1d1c-1b1a-4918-9716-151413121110';
const GB = 1024 ** 3;

const service: MyService = {
  id: GRANT,
  label: 'Phone',
  status: 'active',
  endsAt: '2026-10-25T18:00:00.000Z',
  variant: { id: 'v-30', sku: 'GOLD-30', nameKey: 'catalog.variant.gold30' },
  billingMode: 'prepaid',
  consumedBytes: '0',
  trafficUnlimited: false,
  trafficCapBytes: String(50 * GB),
  frozen: false,
  frozenUntil: null,
  freezeMode: null,
  userMayUnfreeze: false,
};

const PLANS: RenewalPlans = {
  grantId: GRANT,
  ownPlanRenewable: true,
  plans: [
    { variantId: 'v-30', sku: 'GOLD-30', nameKey: 'catalog.variant.gold30', current: true, price: '12.50', currencyCode: 'USD', bytes: String(50 * GB), days: 30 },
    { variantId: 'v-90', sku: 'GOLD-90', nameKey: 'catalog.variant.gold90', current: false, price: '30.00', currencyCode: 'USD', bytes: String(150 * GB), days: 90 },
  ],
  custom: { minGib: 5, maxGib: 500, minDays: 0, maxDays: 0 },
};

const invoice = (over: Partial<RenewalInvoice> = {}): RenewalInvoice => ({
  id: INVOICE,
  nameKey: 'catalog.variant.gold30',
  sku: 'GOLD-30',
  amount: '12.50',
  discount: '0.00',
  total: '12.50',
  currencyCode: 'USD',
  rejected: [],
  renewal: { grantId: GRANT, bytes: String(50 * GB), days: 30 },
  expiresAt: '2026-10-22T12:30:00.000Z',
  ...over,
});

function harness() {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as Mocked<AuthApiClient>;
  const billing = {
    myServices: vi.fn().mockResolvedValue(ok({ total: 1, page: 1, pageSize: 100, hidden: 0, rows: [service] })),
    renewalPlans: vi.fn().mockResolvedValue(ok(PLANS)),
    createRenewalInvoice: vi.fn().mockResolvedValue(ok(invoice())),
    payInvoice: vi.fn().mockResolvedValue(ok({ id: INVOICE, total: '12.50', balanceAfter: '87.50', currencyCode: 'USD', grants: [{ id: GRANT, status: 'active' }] })),
    cancelInvoice: vi.fn().mockResolvedValue(ok({ id: INVOICE, status: 'cancelled' })),
  } as unknown as Mocked<BillingApiClient>;
  const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
  const locale = {
    getKey: vi.fn((_lang: string, ns: string, key: string) => (ns === 'catalog' ? { 'variant.gold30': 'Gold 30', 'variant.gold90': 'Gold 90' }[key] : undefined)),
    getDefaultLanguage: () => 'en',
  } as unknown as LocaleService;
  return { billing, sessions, flow: new RenewalFlow(billing, new ChatAccess(auth, sessions), locale, () => NOW) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);
const labels = (r: { view: { actions?: { label: BotText }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.label);
const bodyOf = (r: { view: { body: BotText } }) => r.view.body;
const stateOf = (r: { nextState: NavState | null }): NavState => {
  if (!r.nextState) throw new Error('the screen ended the conversation');
  return r.nextState;
};
const invoiceState = (data: Record<string, string>): NavState => ({ flow: 'renewal', step: 'renewal.invoice', data: { grantId: GRANT, invoiceId: INVOICE, ...data } });

describe('the buttons', () => {
  it('keep every renewal button under the 64-byte callback cap', () => {
    for (const id of [renewalAction('open', GRANT), renewalAction('plan', GRANT, 12), renewalAction('pay', INVOICE), renewalAction('coupon', INVOICE)]) {
      expect(Buffer.byteLength(id)).toBeLessThanOrEqual(64);
    }
  });

  it("are read the way the notice's button is sent (shared-core)", () => {
    expect(renewalAction('open', GRANT)).toBe(renewalOpenCallback(GRANT));
  });

  it('are offered on an active or suspended service with a plan, never a closed one or one issued without', () => {
    expect(renewalOffered(service)).toBe(true);
    expect(renewalOffered({ ...service, status: 'suspended' })).toBe(true);
    for (const status of ['pending', 'exhausted', 'expired', 'cancelled'] as const) expect(renewalOffered({ ...service, status })).toBe(false);
    expect(renewalOffered({ ...service, variant: null })).toBe(false);
  });
});

describe('the plans', () => {
  it("are billing's, in its order — the own one marked — with what each adds and costs, then the parts the product sells typed", async () => {
    const { flow, billing } = harness();
    const r = await flow.tap(ctx, renewalAction('open', GRANT), null);
    expect(billing.renewalPlans).toHaveBeenCalledWith(GRANT, expect.objectContaining({ accessToken: 'access-1' }));
    expect(ids(r)).toEqual([renewalAction('plan', GRANT, 0), renewalAction('plan', GRANT, 1), renewalAction('gib', GRANT), serviceAction('open', GRANT)]);
    const [own, other] = labels(r);
    expect(own.key).toBe(BotKeys.renewal.planCurrent);
    expect(own.values).toMatchObject({ name: { raw: 'Gold 30' }, price: expect.objectContaining({ values: expect.objectContaining({ amount: '12.50' }) }) });
    expect(other.key).toBe(BotKeys.renewal.plan);
    expect(bodyOf(r)).toMatchObject({ key: BotKeys.renewal.plans, values: { name: { raw: 'Phone' }, notSold: { raw: '' } } });
  });

  it('say when the own plan is no longer sold', async () => {
    const { flow, billing } = harness();
    billing.renewalPlans.mockResolvedValue(ok({ ...PLANS, ownPlanRenewable: false, plans: [PLANS.plans[1]] }));
    const r = await flow.tap(ctx, renewalAction('open', GRANT), null);
    expect(bodyOf(r).values?.notSold).toEqual({ key: BotKeys.renewal.notSold });
  });

  it("tell billing's refusal in billing's words, with the way back to the services", async () => {
    const { flow, billing } = harness();
    billing.renewalPlans.mockResolvedValue(refused('This service can no longer be renewed', 'grant_not_renewable'));
    const r = await flow.tap(ctx, renewalAction('open', GRANT), null);
    expect(bodyOf(r)).toEqual({ raw: 'This service can no longer be renewed' });
    expect(ids(r)).toEqual([ACTIONS.services]);
  });

  it('a service no longer listed is gone', async () => {
    const { flow, billing } = harness();
    billing.myServices.mockResolvedValue(ok({ total: 0, page: 1, pageSize: 100, hidden: 0, rows: [] }));
    const r = await flow.tap(ctx, renewalAction('open', GRANT), null);
    expect(bodyOf(r)).toEqual({ key: BotKeys.services.gone });
    expect(billing.renewalPlans).not.toHaveBeenCalled();
  });
});

describe('the invoice', () => {
  it('a plan picked is invoiced as a renewal of this Grant — no figure sent — and shown with pay, a code and cancel', async () => {
    const { flow, billing } = harness();
    const r = await flow.tap(ctx, renewalAction('plan', GRANT, 1), null);
    expect(billing.createRenewalInvoice).toHaveBeenCalledWith(GRANT, { variantId: 'v-90' }, [], expect.anything());
    expect(bodyOf(r).key).toBe(BotKeys.renewal.invoice);
    expect(bodyOf(r).values).toMatchObject({ total: expect.objectContaining({ values: expect.objectContaining({ amount: '12.50' }) }), discount: { raw: '' } });
    expect(ids(r)).toEqual([renewalAction('pay', INVOICE), renewalAction('coupon', INVOICE), renewalAction('cancel', INVOICE)]);
    expect(r.nextState).toEqual(invoiceState({ variantId: 'v-90' }));
  });

  it('a plan the list no longer holds at that place invoices nothing and shows the plans again', async () => {
    const { flow, billing } = harness();
    const r = await flow.tap(ctx, renewalAction('plan', GRANT, 7), null);
    expect(billing.createRenewalInvoice).not.toHaveBeenCalled();
    expect(bodyOf(r).key).toBe(BotKeys.renewal.plans);
  });

  it('GiB typed asks within its bounds, reads Persian digits, and invoices {gib, days: 0}; anything else is asked again', async () => {
    const { flow, billing } = harness();
    const asked = await flow.tap(ctx, renewalAction('gib', GRANT), null);
    expect(bodyOf(asked)).toMatchObject({ key: BotKeys.renewal.askGib, values: { min: 5, max: 500 } });
    expect(asked.nextState).toEqual({ flow: 'renewal', step: 'renewal.gib', data: { grantId: GRANT } });

    const wrong = await flow.handle({ ...ctx, text: 'twenty' }, stateOf(asked), null);
    expect(bodyOf(wrong)).toEqual({ key: BotKeys.renewal.notANumber });
    expect(wrong.nextState).toEqual(asked.nextState);
    expect(billing.createRenewalInvoice).not.toHaveBeenCalled();

    const r = await flow.handle({ ...ctx, text: '۲۰' }, stateOf(asked), null);
    expect(billing.createRenewalInvoice).toHaveBeenCalledWith(GRANT, { gib: 20, days: 0 }, [], expect.anything());
    expect(r.nextState).toEqual(invoiceState({ gib: '20', days: '0' }));
  });

  it("an out-of-bounds amount is billing's sentence, still asking", async () => {
    const { flow, billing } = harness();
    billing.createRenewalInvoice.mockResolvedValue(refused('Between 5 and 500 GB', 'custom_out_of_bounds'));
    const state: NavState = { flow: 'renewal', step: 'renewal.gib', data: { grantId: GRANT } };
    const r = await flow.handle({ ...ctx, text: '9000' }, state, null);
    expect(bodyOf(r)).toEqual({ raw: 'Between 5 and 500 GB' });
    expect(r.nextState).toEqual(state);
  });

  it("a code gives up the invoice and asks billing again for the same choice with it; a refused code is billing's sentence", async () => {
    const { flow, billing } = harness();
    const asked = await flow.tap(ctx, renewalAction('coupon', INVOICE), invoiceState({ variantId: 'v-90' }));
    expect(bodyOf(asked)).toEqual({ key: BotKeys.renewal.askCoupon });
    billing.createRenewalInvoice.mockResolvedValue(ok(invoice({ id: 'inv-2', rejected: [{ code: 'NOPE', reason: 'not_found', message: 'No such code' }] })));
    const r = await flow.handle({ ...ctx, text: ' NOPE ' }, stateOf(asked), null);
    expect(billing.cancelInvoice).toHaveBeenCalledWith(INVOICE, expect.anything());
    expect(billing.createRenewalInvoice).toHaveBeenCalledWith(GRANT, { variantId: 'v-90' }, ['NOPE'], expect.anything());
    expect(bodyOf(r).values?.rejected).toEqual({ key: BotKeys.renewal.rejected, values: { code: 'NOPE', message: 'No such code' } });
    expect(ids(r)[0]).toBe(renewalAction('pay', 'inv-2'));
  });

  it('a code asked from an old screen sends nothing', async () => {
    const { flow, billing } = harness();
    const r = await flow.tap(ctx, renewalAction('coupon', INVOICE), null);
    expect(bodyOf(r)).toEqual({ key: BotKeys.renewal.stale });
    expect(billing.cancelInvoice).not.toHaveBeenCalled();
  });

  it('cancel gives the invoice up', async () => {
    const { flow, billing } = harness();
    const r = await flow.tap(ctx, renewalAction('cancel', INVOICE), invoiceState({ variantId: 'v-30' }));
    expect(billing.cancelInvoice).toHaveBeenCalledWith(INVOICE, expect.anything());
    expect(bodyOf(r)).toEqual({ key: BotKeys.renewal.cancelled });
    expect(r.nextState).toBeNull();
  });
});

describe('paying', () => {
  it('pays from the wallet, says so with the balance left, and leads back to the service', async () => {
    const { flow, billing } = harness();
    const r = await flow.tap(ctx, renewalAction('pay', INVOICE), invoiceState({ variantId: 'v-30' }));
    expect(billing.payInvoice).toHaveBeenCalledWith(INVOICE, expect.anything());
    expect(bodyOf(r).key).toBe(BotKeys.renewal.paid);
    expect(ids(r)).toEqual([serviceAction('open', GRANT)]);
    expect(r.nextState).toBeNull();
  });

  it('a short wallet says how much is missing, and leads to the top-up and back to the same invoice', async () => {
    const { flow, billing } = harness();
    billing.payInvoice.mockResolvedValue(refused('Not enough balance', 'insufficient_balance', { total: '12.50', balance: '2.50', missing: '10.00', currencyCode: 'USD' }));
    const r = await flow.tap(ctx, renewalAction('pay', INVOICE), null);
    expect(bodyOf(r)).toMatchObject({ key: BotKeys.renewal.shortfall, values: { missing: expect.objectContaining({ values: expect.objectContaining({ amount: '10.00' }) }) } });
    expect(ids(r)).toEqual([ACTIONS.topUp, renewalAction('pay', INVOICE)]);
  });

  it("any other refusal is billing's sentence, with the way back to the services", async () => {
    const { flow, billing } = harness();
    billing.payInvoice.mockResolvedValue(refused('This invoice has expired', 'invoice_expired'));
    const r = await flow.tap(ctx, renewalAction('pay', INVOICE), null);
    expect(bodyOf(r)).toEqual({ raw: 'This invoice has expired' });
    expect(ids(r)).toEqual([ACTIONS.services]);
  });
});

describe('signed out', () => {
  it('asks the user to sign in and reads nothing', async () => {
    const { flow, billing, sessions } = harness();
    vi.mocked(sessions.get).mockResolvedValue(null);
    const r = await flow.tap(ctx, renewalAction('open', GRANT), null);
    expect(bodyOf(r)).toEqual({ key: BotKeys.common.notSignedIn });
    expect(billing.renewalPlans).not.toHaveBeenCalled();
  });
});
