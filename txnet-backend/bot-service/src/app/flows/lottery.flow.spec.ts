import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import type { ChatLottery, ChatLotteryResult } from '../billing-api/engagement.types';
import { ChatContext } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { LOTTERY_EXCLUDED_KEYS, LOTTERY_REFUSAL_KEYS, LotteryFlow, lotteryAction } from './lottery.flow';
import { ACTIONS } from './views';

/**
 * Lotteries from the chat (F-707-p, ADR-0111 points 5, 6). The bot decides
 * nothing: billing's `/lotteries` says which lotteries this user sees and
 * whether they may join, and the entry routes judge it. What would break
 * silently here:
 *  - **a Join offered where billing refuses it** — only on an open `opt_in`
 *    lottery with no entry; Leave only on one the user joined;
 *  - **a button that cannot be sent** — a callback is at most 64 bytes;
 *  - **a reason told as a raw key** — every exclusion and refusal has the
 *    bot's own sentence, read from billing's unions.
 */
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const NOW = new Date('2026-10-03T12:00:00Z');
const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ENGAGEMENT = join(__dirname, '../../../../billing-service/src/app/engagement');
const unionOf = (file: string, name: string) => {
  const m = new RegExp(`export type ${name} =([^;]*);`).exec(readFileSync(join(ENGAGEMENT, file), 'utf8'));
  if (!m) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
};

const lottery = (over: Partial<ChatLottery> = {}): ChatLottery => ({
  id: ID,
  title: 'October draw',
  description: null,
  entryMode: 'opt_in',
  status: 'published',
  closesAt: '2026-10-05T15:30:00.000Z',
  cancelReason: null,
  open: true,
  prizes: [{ rank: 1, label: '50 GB', prizeType: 'bonus_traffic_gb', prizeValue: '50.00', winnersCount: 2 }],
  entry: null,
  ...over,
});

const RESULT: ChatLotteryResult = {
  lotteryId: ID,
  title: 'October draw',
  entrantCount: 9,
  places: [
    { position: 1, ticketNumber: 4, prize: { rank: 1, label: '50 GB' }, delivery: 'passed_on', passedOnReason: 'inactive', replacesPosition: null },
    { position: 2, ticketNumber: 7, prize: { rank: 1, label: '50 GB' }, delivery: 'delivered', passedOnReason: null, replacesPosition: null },
    { position: 3, ticketNumber: 2, prize: { rank: 1, label: '50 GB' }, delivery: 'delivered', passedOnReason: null, replacesPosition: 1 },
    { position: 4, ticketNumber: 9, prize: null, delivery: 'pending', passedOnReason: null, replacesPosition: null },
  ],
  mine: { entrantId: 'e-7', ticketNumber: 7, excludedReason: null },
};

function harness(o: { list?: unknown; join?: unknown; leave?: unknown; result?: unknown } = {}) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as Mocked<AuthApiClient>;
  const billing = {
    lotteries: vi.fn().mockResolvedValue(o.list ?? ok([lottery()])),
    rewardTarget: vi.fn().mockResolvedValue(ok({ chosenGrantId: null, services: [] })),
    joinLottery: vi.fn().mockResolvedValue(o.join ?? ok({ lotteryId: ID, joined: true, replay: false })),
    leaveLottery: vi.fn().mockResolvedValue(o.leave ?? ok({ lotteryId: ID, joined: false, replay: false })),
    lotteryResult: vi.fn().mockResolvedValue(o.result ?? ok(RESULT)),
  } as unknown as Mocked<BillingApiClient>;
  const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
  return { billing, flow: new LotteryFlow(billing, new ChatAccess(auth, sessions), () => NOW) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);

describe('the reasons billing gives', () => {
  it('has a sentence for every exclusion at the close and every refusal of the entry routes', () => {
    expect(Object.keys(LOTTERY_EXCLUDED_KEYS).sort()).toEqual(unionOf('lottery-close.service.ts', 'ExclusionReason'));
    expect(Object.keys(LOTTERY_REFUSAL_KEYS).sort()).toEqual(unionOf('lottery-entry.service.ts', 'LotteryEntryRejection'));
  });

  it('fits every button in a 64-byte callback', () => {
    for (const kind of ['open', 'join', 'leave', 'result'] as const) expect(Buffer.byteLength(lotteryAction(kind, ID))).toBeLessThanOrEqual(64);
  });
});

describe('LotteryFlow', () => {
  it('lists the lotteries billing shows this user, one button each, the title as the tenant wrote it', async () => {
    const { flow } = harness({ list: ok([lottery(), lottery({ id: 'b', title: 'Spring', status: 'drawn', open: false })]) });
    const r = await flow.start(ctx);
    expect(r.view.body).toEqual({ key: BotKeys.lotteries.list, values: { n: 2 } });
    expect(ids(r)).toEqual([lotteryAction('open', ID), lotteryAction('open', 'b')]);
    expect(r.view.actions?.[0][0].label).toEqual({ key: BotKeys.lotteries.item, values: { title: { raw: 'October draw' }, status: { key: BotKeys.lotteries.status.open } } });
    expect(r.nextState).toBeNull();
  });

  it('says there is none in its own words', async () => {
    const { flow } = harness({ list: ok([]) });
    expect((await flow.start(ctx)).view.body).toEqual({ key: BotKeys.lotteries.none });
  });

  it('opens a lottery: prizes, the time left, and Join on an open opt-in one with no entry', async () => {
    const { flow } = harness();
    const r = await flow.tap(ctx, lotteryAction('open', ID));
    expect(r.view.body.key).toBe(BotKeys.lotteries.card);
    expect(r.view.body.values).toMatchObject({
      title: { raw: 'October draw' },
      prizes: { raw: '1. 50 GB ×2' },
      closes: { key: BotKeys.lotteries.closesIn, values: { left: { key: BotKeys.lotteries.left.days, values: { d: 2, h: 3 } } } },
      entry: { key: BotKeys.lotteries.entry.canJoin },
    });
    expect(ids(r)).toEqual([lotteryAction('join', ID), ACTIONS.lotteries]);
  });

  it('offers Leave to one who joined, nothing to an automatic one, and the result once drawn', async () => {
    const joined = await harness({ list: ok([lottery({ entry: { optedInAt: NOW.toISOString(), ticketNumber: null, excludedReason: null } })]) }).flow.tap(ctx, lotteryAction('open', ID));
    expect(joined.view.body.values?.entry).toEqual({ key: BotKeys.lotteries.entry.joined });
    expect(ids(joined)).toEqual([lotteryAction('leave', ID), ACTIONS.lotteries]);

    const automatic = await harness({ list: ok([lottery({ entryMode: 'automatic' })]) }).flow.tap(ctx, lotteryAction('open', ID));
    expect(automatic.view.body.values?.entry).toEqual({ key: BotKeys.lotteries.entry.automatic });
    expect(ids(automatic)).toEqual([ACTIONS.lotteries]);

    const drawn = await harness({ list: ok([lottery({ status: 'drawn', open: false, entry: { optedInAt: null, ticketNumber: 7, excludedReason: null } })]) }).flow.tap(ctx, lotteryAction('open', ID));
    expect(drawn.view.body.values).toMatchObject({ entry: { key: BotKeys.lotteries.entry.ticket, values: { n: 7 } }, closes: { raw: '' } });
    expect(ids(drawn)).toEqual([lotteryAction('result', ID), ACTIONS.lotteries]);
  });

  it('tells an exclusion by its reason, and a cancel with the admin’s reason', async () => {
    const excluded = await harness({ list: ok([lottery({ status: 'frozen', open: false, entry: { optedInAt: null, ticketNumber: null, excludedReason: 'phone_unverified' } })]) }).flow.tap(
      ctx,
      lotteryAction('open', ID),
    );
    expect(excluded.view.body.values?.entry).toEqual({ key: BotKeys.lotteries.entry.excluded, values: { reason: { key: BotKeys.lotteries.excluded.phone_unverified } } });

    const cancelled = await harness({ list: ok([lottery({ status: 'cancelled', open: false, cancelReason: 'Prize supplier fell through' })]) }).flow.tap(ctx, lotteryAction('open', ID));
    expect(cancelled.view.body.values?.status).toEqual({ key: BotKeys.lotteries.status.cancelled, values: { reason: { raw: 'Prize supplier fell through' } } });
  });

  it('joins through billing and shows the card again as billing now sees it', async () => {
    const { flow, billing } = harness();
    billing.lotteries
      .mockResolvedValueOnce(ok([lottery({ entry: { optedInAt: NOW.toISOString(), ticketNumber: null, excludedReason: null } })]));
    const r = await flow.tap(ctx, lotteryAction('join', ID));
    expect(billing.joinLottery).toHaveBeenCalledWith(ID, expect.objectContaining({ accessToken: 'access-1', platform: 'telegram' }));
    expect(r.view.body.values?.entry).toEqual({ key: BotKeys.lotteries.entry.joined });
  });

  it('tells a refused join by its reason, and an unknown one by billing’s message', async () => {
    const closed = await harness({ join: { ok: false, msg: 'closed', error: { reason: 'closed' } } }).flow.tap(ctx, lotteryAction('join', ID));
    expect(closed.view.body).toEqual({ key: BotKeys.lotteries.refusals.closed });
    const unknown = await harness({ leave: { ok: false, msg: 'Something new', error: { reason: 'brand_new' } } }).flow.tap(ctx, lotteryAction('leave', ID));
    expect(unknown.view.body).toEqual({ raw: 'Something new' });
  });

  it('shows a drawn result: each prize place and its delivery, and the user’s own outcome', async () => {
    const r = await harness().flow.tap(ctx, lotteryAction('result', ID));
    expect(r.view.body).toMatchObject({
      key: BotKeys.lotteries.result,
      values: {
        title: { raw: 'October draw' },
        n: 9,
        places: { raw: '1. #4 — 50 GB ↪️\n2. #7 — 50 GB ✅\n3. #2 — 50 GB ✅ (1)' },
        mine: { key: BotKeys.lotteries.mine.won, values: { prize: { raw: '50 GB' } } },
      },
    });
  });

  it('tells a ticket that did not win, and a lottery not drawn yet', async () => {
    const lost = await harness({ result: ok({ ...RESULT, mine: { entrantId: 'e-9', ticketNumber: 9, excludedReason: null } }) }).flow.tap(ctx, lotteryAction('result', ID));
    expect(lost.view.body.values?.mine).toEqual({ key: BotKeys.lotteries.mine.lost, values: { n: 9 } });
    const notYet = await harness({ result: { ok: false, msg: 'x', error: { reason: 'not_drawn' } } }).flow.tap(ctx, lotteryAction('result', ID));
    expect(notYet.view.body).toEqual({ key: BotKeys.lotteries.refusals.not_drawn });
  });
});
