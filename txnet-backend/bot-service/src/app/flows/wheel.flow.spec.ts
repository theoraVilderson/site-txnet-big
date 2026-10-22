import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import type { SpinAnswer, UserWheel } from '../billing-api/engagement.types';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { ACTIONS } from './views';
import { PRIZE_SERVICE_ACTION_PREFIX } from './prize-service.flow';
import { WheelFlow } from './wheel.flow';

/**
 * Spinning from the chat (F-707-h, ADR-0111 point 4). The bot decides nothing:
 * billing's `/wheel` says whether this user may spin and `/wheel/spin` picks.
 * What would break silently here:
 *  - **a retried tap spinning twice** — the Spin button carries one
 *    `requestId` for the screen; a lost answer keeps it, so the retry is the
 *    same spin (F-707-d rule 1); any answer ends it;
 *  - **a refusal told as billing's raw message** — every reason has the bot's
 *    own sentence, the same set the panel has;
 *  - **a won coupon with no code** — the code is the prize, so it is in the chat.
 */
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });

const WHEEL: UserWheel = {
  tenantDay: '2026-10-03',
  version: 2,
  currencyCode: 'USD',
  prizes: [
    { position: 1, label: '1 GB', prizeType: 'bonus_traffic_gb', prizeValue: '1.00', oddsPercent: '30.00' },
    { position: 2, label: 'Nothing', prizeType: 'empty', prizeValue: '0.00', oddsPercent: '70.00' },
  ],
  eligible: true,
  refusalReason: null,
  spinsLeftToday: 1,
  nextSpinAt: null,
};
const answer = (over: Partial<SpinAnswer> = {}): SpinAnswer => ({
  attemptId: 'a-1',
  status: 'awarded',
  refusalReason: null,
  position: 1,
  prize: { position: 1, label: '1 GB', prizeType: 'bonus_traffic_gb', prizeValue: '1.50' },
  reward: null,
  replay: false,
  ...over,
});

function harness(o: { wheel?: unknown; spin?: unknown; services?: number } = {}) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as Mocked<AuthApiClient>;
  const billing = {
    wheel: vi.fn().mockResolvedValue(o.wheel ?? ok(WHEEL)),
    spinWheel: vi.fn().mockResolvedValue(o.spin ?? ok(answer())),
    rewardTarget: vi.fn().mockResolvedValue(ok({ chosenGrantId: null, services: Array.from({ length: o.services ?? 0 }, (_, i) => ({ id: `g-${i}` })) })),
  } as unknown as Mocked<BillingApiClient>;
  const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
  return { billing, flow: new WheelFlow(billing, new ChatAccess(auth, sessions)) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);

describe('WheelFlow', () => {
  it('offers the prize-service row under the odds only when there is a service to choose (F-707-t)', async () => {
    expect(ids(await harness({ services: 2 }).flow.start(ctx))).toEqual([ACTIONS.wheelSpin, `${PRIZE_SERVICE_ACTION_PREFIX}o`]);
    expect(ids(await harness({ services: 1 }).flow.start(ctx))).toEqual([ACTIONS.wheelSpin]);
  });

  it('shows the public odds and a Spin button holding one key for this screen', async () => {
    const { flow } = harness();
    const r = await flow.start(ctx);
    expect(r.view.body.key).toBe(BotKeys.wheel.screen);
    expect(r.view.body.values?.odds).toEqual({ raw: '1 GB — 30%\nNothing — 70%' });
    expect(r.view.body.values?.status).toEqual({ key: BotKeys.wheel.canSpin, values: { n: 1 } });
    expect(ids(r)).toContain(ACTIONS.wheelSpin);
    expect(r.nextState).toMatchObject({ flow: 'wheel', step: 'wheel.offer' });
    expect(r.nextState?.data.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says why not, with no Spin button, when billing says this user may not spin', async () => {
    const { flow } = harness({ wheel: ok({ ...WHEEL, eligible: false, refusalReason: 'cooldown' }) });
    const r = await flow.start(ctx);
    expect(r.view.body.values?.status).toEqual({ key: BotKeys.wheel.cannotSpin, values: { reason: { key: BotKeys.wheel.refusals.cooldown } } });
    expect(ids(r)).not.toContain(ACTIONS.wheelSpin);
  });

  it('says there is no wheel today in its own words', async () => {
    const { flow } = harness({ wheel: { ok: false, msg: 'no_wheel', error: { reason: 'no_wheel' } } });
    expect((await flow.start(ctx)).view.body).toEqual({ key: BotKeys.wheel.none });
  });

  it('spins with the screen key and tells the prize; the conversation ends', async () => {
    const { flow, billing } = harness();
    const state: NavState = { flow: 'wheel', step: 'wheel.offer', data: { requestId: 'req-1' } };
    const r = await flow.handle(ctx, state, ACTIONS.wheelSpin);
    expect(billing.spinWheel).toHaveBeenCalledWith('req-1', expect.objectContaining({ accessToken: 'access-1', platform: 'telegram' }));
    expect(r.view.body).toEqual({ key: BotKeys.wheel.won.bonus_traffic_gb, values: { value: '1.5', label: '1 GB', code: '' } });
    expect(r.nextState).toBeNull();
  });

  it('names a won coupon by its code', async () => {
    const coupon = { id: 'c', code: 'WHEEL-7Q2', percent: '20.00', expiresAt: '2026-10-10T00:00:00Z' };
    const { flow } = harness({
      spin: ok(answer({ prize: { position: 1, label: '20% off', prizeType: 'discount_coupon', prizeValue: '20.00' }, reward: { grantId: null, coupon } })),
    });
    const r = await flow.handle(ctx, { flow: 'wheel', step: 'wheel.offer', data: { requestId: 'req-1' } }, ACTIONS.wheelSpin);
    expect(r.view.body).toEqual({ key: BotKeys.wheel.won.discount_coupon, values: { value: '20', label: '20% off', code: 'WHEEL-7Q2' } });
  });

  it('tells a recorded refusal by its reason, and an empty slot as nothing', async () => {
    const refused = harness({ spin: ok(answer({ status: 'rejected_ineligible', refusalReason: 'daily_limit', position: null, prize: null })) });
    const r = await refused.flow.handle(ctx, { flow: 'wheel', step: 'wheel.offer', data: { requestId: 'req-1' } }, ACTIONS.wheelSpin);
    expect(r.view.body).toEqual({ key: BotKeys.wheel.refused, values: { reason: { key: BotKeys.wheel.refusals.daily_limit } } });
    const nothing = harness({ spin: ok(answer({ prize: null, position: 2 })) });
    const n = await nothing.flow.handle(ctx, { flow: 'wheel', step: 'wheel.offer', data: { requestId: 'req-1' } }, ACTIONS.wheelSpin);
    expect(n.view.body).toEqual({ key: BotKeys.wheel.won.empty });
  });

  it('keeps the same key after a lost answer, so the retry is the same spin', async () => {
    const { flow } = harness({ spin: { ok: false, msg: 'try again' } });
    const state: NavState = { flow: 'wheel', step: 'wheel.offer', data: { requestId: 'req-1' } };
    const r = await flow.handle(ctx, state, ACTIONS.wheelSpin);
    expect(r.view.body).toEqual({ key: BotKeys.wheel.failed });
    expect(r.nextState?.data.requestId).toBe('req-1');
    expect(ids(r)).toContain(ACTIONS.wheelSpin);
  });
});
