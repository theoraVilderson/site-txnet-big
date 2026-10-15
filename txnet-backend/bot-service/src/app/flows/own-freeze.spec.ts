import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import type { MyService } from '../billing-api/services.types';
import { ChatContext } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { LocaleService } from '../locale/locale.service';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { frozenNoteOf, ownFreezeOf } from './own-freeze';
import { ServicesFlow, serviceAction } from './services.flow';
import { ACTIONS } from './views';

/**
 * The user's own freeze in the chat (F-0401-g), as the panel's (panel-web
 * `contract.own-freeze.md`). Billing decides; what would break silently here:
 *  - **a button billing refuses** — a freeze only on a live metered service,
 *    an unfreeze only where billing's `userMayUnfreeze` says so, never
 *    re-derived from `freezeMode`;
 *  - **an act on one tap** — both ask first, and a declined question sends nothing;
 *  - **the daily cap unexplained** — how many, and when the next is allowed.
 */
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const NOW = new Date('2026-10-15T12:00:00Z');
const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';

const metered = (over: Partial<MyService> = {}): MyService => ({
  id: ID,
  label: 'Home',
  status: 'active',
  endsAt: null,
  variant: null,
  billingMode: 'metered',
  consumedBytes: '0',
  trafficUnlimited: false,
  trafficCapBytes: null,
  frozen: false,
  frozenUntil: null,
  freezeMode: null,
  userMayUnfreeze: false,
  ...over,
});
const frozen = (mode: MyService['freezeMode'], mayUnfreeze: boolean, over: Partial<MyService> = {}) =>
  metered({ status: 'suspended', frozen: true, freezeMode: mode, userMayUnfreeze: mayUnfreeze, ...over });

function harness(rows: MyService[], o: { freeze?: unknown; unfreeze?: unknown } = {}) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as Mocked<AuthApiClient>;
  const billing = {
    myServices: vi.fn().mockResolvedValue(ok({ total: rows.length, page: 1, pageSize: 100, hidden: 0, rows })),
    freezeOwnGrant: vi.fn().mockResolvedValue(o.freeze ?? ok({ grantId: ID, freezeMode: 'self', configsDisabled: 2 })),
    unfreezeOwnGrant: vi.fn().mockResolvedValue(o.unfreeze ?? ok({ grantId: ID, endsAt: null, configsRestored: 2 })),
  } as unknown as Mocked<BillingApiClient>;
  const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
  const locale = { getKey: vi.fn(), getDefaultLanguage: () => 'fa' } as unknown as LocaleService;
  return { billing, flow: new ServicesFlow(billing, new ChatAccess(auth, sessions), locale, () => NOW) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);

describe('what a service offers (panel rule 1)', () => {
  it('a freeze on a live metered service, an unfreeze where billing lets the user, else nothing', () => {
    expect(ownFreezeOf(metered())).toBe('freeze');
    expect(ownFreezeOf(metered({ billingMode: 'prepaid' }))).toBeNull();
    expect(ownFreezeOf(metered({ status: 'suspended' }))).toBeNull();
    expect(ownFreezeOf(frozen('self', true))).toBe('unfreeze');
    expect(ownFreezeOf(frozen('soft', true))).toBe('unfreeze');
    expect(ownFreezeOf(frozen('hard', false))).toBeNull();
    // A soft freeze waiting for a panel is support's: billing says false, and that is the answer.
    expect(ownFreezeOf(frozen('soft', false))).toBeNull();
  });

  it('a frozen service says who froze it, and when a timed freeze lifts (panel rule 2)', () => {
    expect(frozenNoteOf(metered(), NOW)).toEqual({ raw: '' });
    expect(frozenNoteOf(frozen('self', true), NOW)).toMatchObject({ key: BotKeys.services.frozenBy.self });
    expect(frozenNoteOf(frozen('soft', true), NOW)).toMatchObject({ key: BotKeys.services.frozenBy.soft });
    expect(frozenNoteOf(frozen('soft', false), NOW)).toMatchObject({ key: BotKeys.services.frozenBy.hard });
    const timed = frozenNoteOf(frozen('hard', false, { frozenUntil: '2026-10-17T15:00:00.000Z' }), NOW);
    expect(timed.values?.until).toEqual({ key: BotKeys.services.frozenUntil, values: { left: { key: BotKeys.services.left.days, values: { d: 2, h: 3 } } } });
  });
});

describe('freezing from the chat', () => {
  it('puts the freeze on the screen and the frozen note in it', async () => {
    expect(ids(await harness([metered()]).flow.tap(ctx, serviceAction('open', ID)))).toEqual([serviceAction('freezeAsk', ID), ACTIONS.services]);
    const r = await harness([frozen('hard', false)]).flow.tap(ctx, serviceAction('open', ID));
    expect(ids(r)).toEqual([ACTIONS.services]);
    expect(r.view.body.values?.frozen).toMatchObject({ key: BotKeys.services.frozenBy.hard });
  });

  it('asks first, and a declined question sends nothing (panel rule 4)', async () => {
    const { flow, billing } = harness([metered()]);
    const asked = await flow.tap(ctx, serviceAction('freezeAsk', ID));
    expect(asked.view.body.key).toBe(BotKeys.services.freezeAsk);
    expect(ids(asked)).toEqual([serviceAction('freeze', ID), serviceAction('open', ID)]);
    await flow.tap(ctx, serviceAction('open', ID));
    expect(billing.freezeOwnGrant).not.toHaveBeenCalled();
  });

  it('freezes on the yes, then shows the service as billing now lists it (panel rule 5)', async () => {
    const { flow, billing } = harness([metered()]);
    const r = await flow.tap(ctx, serviceAction('freeze', ID));
    expect(billing.freezeOwnGrant).toHaveBeenCalledWith(ID, expect.objectContaining({ accessToken: 'access-1' }));
    expect(billing.myServices).toHaveBeenCalledTimes(1);
    expect(r.view.body.key).toBe(BotKeys.services.card);
  });

  it('unfreezes on the yes after asking', async () => {
    const { flow, billing } = harness([frozen('self', true)]);
    expect(ids(await flow.tap(ctx, serviceAction('unfreezeAsk', ID)))).toEqual([serviceAction('unfreeze', ID), serviceAction('open', ID)]);
    await flow.tap(ctx, serviceAction('unfreeze', ID));
    expect(billing.unfreezeOwnGrant).toHaveBeenCalledWith(ID, expect.anything());
  });

  it('names the daily cap and when the next freeze is allowed (panel rule 6)', async () => {
    const limited = { ok: false, msg: 'Too many', error: { reason: 'self_freeze_limit', facts: { limit: 3, nextAtMs: NOW.getTime() + 95 * 60_000 } } };
    const r = await harness([metered()], { freeze: limited }).flow.tap(ctx, serviceAction('freeze', ID));
    expect(r.view.body).toEqual({
      key: BotKeys.services.freezeLimited,
      values: { limit: 3, left: { key: BotKeys.services.left.hours, values: { h: 1, m: 35 } } },
    });
    expect(ids(r)).toEqual([serviceAction('open', ID)]);
  });

  it("tells any other refusal in billing's sentence (panel rule 7)", async () => {
    const off = { ok: false, msg: 'Freezing is not available in this store', error: { reason: 'self_freeze_off' } };
    const r = await harness([metered()], { freeze: off }).flow.tap(ctx, serviceAction('freeze', ID));
    expect(r.view.body).toEqual({ raw: 'Freezing is not available in this store' });
    expect(ids(r)).toEqual([serviceAction('open', ID)]);
  });

  it('keeps every freeze button under the 64-byte callback cap', () => {
    for (const kind of ['freezeAsk', 'freeze', 'unfreezeAsk', 'unfreeze'] as const) expect(Buffer.byteLength(serviceAction(kind, ID))).toBeLessThanOrEqual(64);
  });
});
