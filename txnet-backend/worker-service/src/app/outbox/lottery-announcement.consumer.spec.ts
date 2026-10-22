/**
 * A new lottery told to its group (F-707-q, user 2026-10-03). What would break
 * silently here, and nowhere else:
 *  - **a member told twice** — a redelivered event, or one dead-lettered half
 *    way, is told again from the first page; the per-member event id is the
 *    same every time, so the ledger row and the sender's markers hold it once;
 *  - **a muted member told** — the user's `lottery` mute is the ledger's;
 *  - **an automatic lottery on the bot** — it asks nothing of the user, so the
 *    inbox alone; an opt-in one reaches the bot, held by quiet hours;
 *  - **the fan-out outliving the lottery** — a cancel or the close ends it at
 *    the next page.
 */
import { OutboxEventType } from '@txnet-backend/shared-core';

import { LotteryAnnouncementConsumer, announcementEventId } from './lottery-announcement.consumer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOTTERY = '0f0e0d0c-0b0a-4908-8706-050403020100';
const U = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

type Page = { open: boolean; userIds: string[]; next: string | null; entryMode?: string; prizeChoices?: Record<string, { label: string | null; sku: string | null; nameKey: string | null } | null> };

function harness(o: { pages: Page[]; claims?: Record<string, unknown>; failClaim?: string }) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  let page = 0;
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const answer = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, msg: 'ok', data }) });
    if (url.includes('/audience')) {
      const p = o.pages[page++] ?? { open: false, userIds: [], next: null };
      return answer({ lotteryId: LOTTERY, tenantId: TENANT, title: 'October draw', entryMode: p.entryMode ?? 'opt_in', ...p });
    }
    if (url.endsWith('/lottery/claim')) {
      if (body.userId === o.failClaim) return { ok: false, status: 502, json: async () => ({}) };
      return answer(o.claims?.[body.userId] ?? { deliver: 'now' });
    }
    if (url.endsWith('/retention/hold')) return answer({ held: true });
    throw new Error(`unexpected ${url}`);
  });
  const config = {
    get: (k: string, d?: unknown) =>
      ({ BILLING_API_BASE_URL: 'http://billing', NOTIFICATION_API_BASE_URL: 'http://notification', SERVICE_AUTH_TOKEN: 'svc' })[k] ?? d,
  };
  const sent: Array<Record<string, unknown>> = [];
  const consumer = new LotteryAnnouncementConsumer({} as never, {} as never, {} as never, config as never);
  (consumer as unknown as { sender: { send: (n: Record<string, unknown>) => Promise<void> } }).sender = { send: async (n) => void sent.push(n) };
  return { consumer, calls, sent };
}

const event = (payload: Record<string, unknown> = { tenantId: TENANT, lotteryId: LOTTERY, title: 'October draw', entryMode: 'opt_in' }) =>
  ({ id: 'ev-1', type: OutboxEventType.LOTTERY_PUBLISHED, payload }) as never;

afterEach(() => vi.unstubAllGlobals());

describe('LotteryAnnouncementConsumer', () => {
  it('tells every member of an opt-in lottery on the inbox and the bot, page after page, with the lottery to join', async () => {
    const { consumer, calls, sent } = harness({
      pages: [
        { open: true, userIds: [U(1), U(2)], next: U(2) },
        { open: true, userIds: [U(3)], next: null },
      ],
    });
    await consumer.handle(event());
    expect(calls.filter((c) => c.url.includes('/audience')).map((c) => c.url)).toEqual([
      `http://billing/api/internal/billing/engagement/lotteries/${LOTTERY}/audience?limit=500`,
      `http://billing/api/internal/billing/engagement/lotteries/${LOTTERY}/audience?limit=500&after=${U(2)}`,
    ]);
    expect(sent.map((n) => (n.person as { userId: string }).userId)).toEqual([U(1), U(2), U(3)]);
    expect(sent[0]).toEqual({
      consumer: 'lottery-announcement',
      eventId: announcementEventId(LOTTERY, U(1)),
      person: { tenantId: TENANT, userId: U(1), template: 'lotteryOpened', params: { title: 'October draw', lotteryId: LOTTERY } },
      only: ['inbox', 'bot'],
      class: 'important',
    });
  });

  it('claims each member under one id per lottery and member, the same on every delivery', async () => {
    expect(announcementEventId(LOTTERY, U(1))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(announcementEventId(LOTTERY, U(1))).toBe(announcementEventId(LOTTERY, U(1)));
    expect(announcementEventId(LOTTERY, U(1))).not.toBe(announcementEventId(LOTTERY, U(2)));
    const { consumer, calls } = harness({ pages: [{ open: true, userIds: [U(1)], next: null }] });
    await consumer.handle(event());
    expect(calls.find((c) => c.url.endsWith('/lottery/claim'))?.body).toEqual({ eventId: announcementEventId(LOTTERY, U(1)), lotteryId: LOTTERY, userId: U(1) });
  });

  it('skips a muted member, and holds the bot of one in quiet hours with the words to tell later', async () => {
    const botAt = '2026-10-03T20:30:00.000Z';
    const { consumer, calls, sent } = harness({
      pages: [{ open: true, userIds: [U(1), U(2)], next: null }],
      claims: { [U(1)]: { deliver: 'muted' }, [U(2)]: { deliver: 'held', botAt } },
    });
    await consumer.handle(event());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ eventId: announcementEventId(LOTTERY, U(2)), only: ['inbox'] });
    expect(calls.find((c) => c.url.endsWith('/retention/hold'))?.body).toEqual({
      eventId: announcementEventId(LOTTERY, U(2)),
      notice: OutboxEventType.LOTTERY_PUBLISHED,
      period: `${LOTTERY}:${U(2)}`,
      tenantId: TENANT,
      template: 'lotteryOpened',
      params: { title: 'October draw', lotteryId: LOTTERY },
      botAt,
    });
  });

  it('tells an automatic lottery in the inbox only, and holds nothing', async () => {
    const { consumer, calls, sent } = harness({ pages: [{ open: true, userIds: [U(1)], next: null, entryMode: 'automatic' }], claims: { [U(1)]: { deliver: 'held', botAt: '2026-10-03T20:30:00.000Z' } } });
    await consumer.handle(event({ tenantId: TENANT, lotteryId: LOTTERY, title: 'October draw', entryMode: 'automatic' }));
    expect(sent).toEqual([expect.objectContaining({ person: expect.objectContaining({ template: 'lotteryOpenedAutomatic' }), only: ['inbox'] })]);
    expect(calls.some((c) => c.url.endsWith('/retention/hold'))).toBe(false);
  });

  it('tells an automatic lottery on the bot too, held in quiet hours, to a member with a prize service to choose (F-707-z)', async () => {
    const family = { label: 'Family', sku: 'GOLD-50', nameKey: null };
    const { consumer, calls, sent } = harness({
      pages: [{ open: true, userIds: [U(1), U(2), U(3)], next: null, entryMode: 'automatic', prizeChoices: { [U(1)]: family, [U(2)]: null } }],
      claims: { [U(2)]: { deliver: 'held', botAt: '2026-10-03T20:30:00.000Z' } },
    });
    await consumer.handle(event({ tenantId: TENANT, lotteryId: LOTTERY, title: 'October draw', entryMode: 'automatic' }));
    const base = { title: 'October draw', lotteryId: LOTTERY, prizeChoice: '1' };
    expect(sent).toEqual([
      expect.objectContaining({ person: expect.objectContaining({ userId: U(1), template: 'lotteryOpenedAutomatic', params: { ...base, serviceLabel: 'Family', serviceSku: 'GOLD-50' } }), only: ['inbox', 'bot'], class: 'important' }),
      expect.objectContaining({ person: expect.objectContaining({ userId: U(2), params: base }), only: ['inbox'], class: 'important' }),
      expect.objectContaining({ person: expect.objectContaining({ userId: U(3), template: 'lotteryOpenedAutomatic', params: { title: 'October draw', lotteryId: LOTTERY } }), only: ['inbox'], class: 'info' }),
    ]);
    expect(calls.find((c) => c.url.endsWith('/retention/hold'))?.body).toMatchObject({ template: 'lotteryOpenedAutomatic', params: base });
  });

  it("names the prize service in an opt-in lottery's announcement too (F-707-z)", async () => {
    const { consumer, sent } = harness({ pages: [{ open: true, userIds: [U(1)], next: null, prizeChoices: { [U(1)]: null } }] });
    await consumer.handle(event());
    expect(sent[0]).toMatchObject({ person: { template: 'lotteryOpened', params: { title: 'October draw', lotteryId: LOTTERY, prizeChoice: '1' } }, only: ['inbox', 'bot'] });
  });

  it('stops when billing says the lottery is no longer open — cancelled or closed', async () => {
    const { consumer, sent } = harness({ pages: [{ open: false, userIds: [], next: null }] });
    await consumer.handle(event());
    expect(sent).toEqual([]);
  });

  it('tells the others when one member fails, then throws so the event is delivered again', async () => {
    const { consumer, sent } = harness({ pages: [{ open: true, userIds: [U(1), U(2)], next: null }], failClaim: U(1) });
    await expect(consumer.handle(event())).rejects.toThrow(/1 of 2/);
    expect(sent.map((n) => (n.person as { userId: string }).userId)).toEqual([U(2)]);
  });

  it('refuses an event without its lottery', async () => {
    const { consumer } = harness({ pages: [] });
    await expect(consumer.handle(event({ tenantId: TENANT }))).rejects.toThrow(/lottery/);
  });
});
