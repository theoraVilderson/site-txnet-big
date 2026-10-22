import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import type { ChatPrizeService, ChatRewardTarget } from '../billing-api/engagement.types';
import { ChatContext } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { LocaleService } from '../locale/locale.service';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import type { BotText } from '@txnet-backend/messenger';
import { PRIZE_SERVICE_ACTION_PREFIX, PrizeServiceFlow, prizeServiceRows } from './prize-service.flow';
import { bytesLabel } from './service-words';

/**
 * The prize service in the chat (F-707-t, billing F-707-r): which service GB
 * and days won on the wheel or in a lottery go to. What would break silently:
 *  - **a choice told that billing does not hold** — the chat says what
 *    billing answered, and a refusal is its reason's sentence, never "saved";
 *  - **the button offered where there is nothing to choose** — one service,
 *    or a read that failed, shows no button on the wheel or lottery screens;
 *  - **a service named by its id** — as My services names it, a days-only one marked.
 */
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const svc = (id: string, o: Partial<ChatPrizeService> = {}): ChatPrizeService => ({
  id, label: null, variant: { id: `v-${id}`, sku: `SKU-${id.slice(-1)}`, nameKey: 'catalog.p.x' }, endsAt: null, remainingBytes: null, takesTraffic: true, takesDays: true, ...o,
});
const TWO: ChatRewardTarget = { chosenGrantId: B, services: [svc(A, { label: 'Phone', remainingBytes: String(6 * 1024 ** 3) }), svc(B, { takesTraffic: false })] };
const FOREVER: BotText = { key: BotKeys.services.time.permanent };
/** An option: the name, when it ends, and what is left when capped (F-707-x). */
const option = (name: BotText, left?: string): BotText =>
  left ? { key: BotKeys.prizeService.optionWithLeft, values: { name, when: FOREVER, left: { raw: left } } } : { key: BotKeys.prizeService.option, values: { name, when: FOREVER } };

function harness(o: { read?: unknown; choose?: unknown } = {}) {
  const auth = { refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })) } as unknown as Mocked<AuthApiClient>;
  const billing = {
    rewardTarget: vi.fn().mockResolvedValue(o.read ?? ok(TWO)),
    chooseRewardTarget: vi.fn().mockResolvedValue(o.choose ?? ok(TWO)),
  } as unknown as Mocked<BillingApiClient>;
  const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
  const locale = { getKey: () => undefined, getDefaultLanguage: () => 'fa' } as unknown as LocaleService;
  return { billing, flow: new PrizeServiceFlow(billing, new ChatAccess(auth, sessions), locale) };
}

const OPEN = `${PRIZE_SERVICE_ACTION_PREFIX}o`;
const buttons = (r: { view: { actions?: { id: string; label: unknown }[][] } }) => (r.view.actions ?? []).flat();

describe('PrizeServiceFlow', () => {
  it('lists automatic first, then each service by its name, the chosen one marked', async () => {
    const { flow } = harness();
    const r = await flow.tap(ctx, OPEN);
    expect(r.view.body.key).toBe(BotKeys.prizeService.screen);
    expect(buttons(r).map((b) => [b.id, b.label])).toEqual([
      [`${PRIZE_SERVICE_ACTION_PREFIX}a`, { key: BotKeys.prizeService.automatic }],
      [`${PRIZE_SERVICE_ACTION_PREFIX}g:${A}`, option({ raw: 'Phone' }, bytesLabel(String(6 * 1024 ** 3)))],
      [`${PRIZE_SERVICE_ACTION_PREFIX}g:${B}`, { key: BotKeys.prizeService.chosen, values: { name: option({ key: BotKeys.prizeService.daysOnly, values: { name: { raw: 'SKU-b' } } }) } }],
    ]);
  });

  it('saves a service by its id, automatic as null, and says what billing now holds', async () => {
    const { flow, billing } = harness({ choose: ok({ ...TWO, chosenGrantId: A }) });
    const r = await flow.tap(ctx, `${PRIZE_SERVICE_ACTION_PREFIX}g:${A}`);
    expect(billing.chooseRewardTarget).toHaveBeenCalledWith(A, expect.anything());
    expect(r.view.body).toEqual({ key: BotKeys.prizeService.saved, values: { current: option({ raw: 'Phone' }, bytesLabel(String(6 * 1024 ** 3))) } });
    await flow.tap(ctx, `${PRIZE_SERVICE_ACTION_PREFIX}a`);
    expect(billing.chooseRewardTarget).toHaveBeenLastCalledWith(null, expect.anything());
  });

  it("tells a refusal by its reason's own sentence", async () => {
    const { flow } = harness({ choose: { ok: false, msg: 'billing text', error: { reason: 'grant_not_eligible' } } });
    const r = await flow.tap(ctx, `${PRIZE_SERVICE_ACTION_PREFIX}g:${A}`);
    expect(r.view.body).toEqual({ key: BotKeys.prizeService.refusals.grant_not_eligible });
  });
});

describe('prizeServiceRows', () => {
  it('offers the button only when there are two services or more to choose from', async () => {
    const call = { lang: 'fa', accessToken: 'a', platform: 'telegram' as const, botTenantId: 't' };
    expect((await prizeServiceRows(harness().billing, call)).flat().map((b) => b.id)).toEqual([OPEN]);
    expect(await prizeServiceRows(harness({ read: ok({ chosenGrantId: null, services: [svc(A)] }) }).billing, call)).toEqual([]);
    expect(await prizeServiceRows(harness({ read: { ok: false, msg: 'down' } }).billing, call)).toEqual([]);
  });
});
