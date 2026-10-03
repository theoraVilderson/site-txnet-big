/**
 * The user's side of support (F-033-b, ADR-0112), against a real Postgres
 * built from the committed migration history.
 *
 * What would break silently, and only a database can show:
 *  - `seq` is gap-free and unique when one user sends from two devices at once
 *    (point 4) — the row lock on `conversation` is the whole mechanism;
 *  - a user reaches only their own conversations, inside their tenant too
 *    (invariant 6) — a wrong `where` reads like a working inbox;
 *  - an agent's internal note never reaches the user, nor counts as unread
 *    (invariant 5);
 *  - the status follows who wrote last, a resolved thread reopens, a closed one
 *    refuses (invariant 7);
 *  - a send in a month with no partition still lands (point 3).
 *
 *   npm run test:int
 */
import { PrismaClient } from '@prisma/client';
import { runWithTenant, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import type { PrismaService } from '../prisma/prisma.service';
import { ConversationRefused, SupportCaller, SupportConversationService } from './conversations.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const ALICE: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a1' };
const AMIR: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a2' };
const ARASH: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a3' };
const ROYA: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a4' };
const BEHNAZ: SupportCaller = { tenantId: RESELLER_B, userId: '33333333-3333-4333-8333-3333333333b1' };
const AGENT = '44444444-4444-4444-8444-444444444441';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let support: SupportConversationService;

const as = <T>(caller: SupportCaller, work: () => Promise<T>) => runWithTenant({ id: caller.tenantId }, work);

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (e) {
    if (e instanceof ConversationRefused) return e.reason;
    throw e;
  }
  return 'accepted';
};

/** An agent's reply or note, written as F-033-d will: seq from the same counter. */
async function agentWrites(conversationId: string, body: string, internal = false) {
  await owner.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ lastSeq: number; tenantId: string }[]>`
      UPDATE support.conversation SET "lastSeq" = "lastSeq" + 1,
        "firstResponseAt" = COALESCE("firstResponseAt", now()),
        status = CASE WHEN ${internal} THEN status ELSE 'pending_user'::support."ConversationStatus" END
      WHERE id = ${conversationId}::uuid RETURNING "lastSeq", "tenantId"::text`;
    await tx.$executeRaw`
      INSERT INTO support.message (id, "createdAt", "tenantId", "conversationId", seq, "senderKind", "senderUserId", body, internal)
      VALUES (gen_random_uuid(), now(), ${row.tenantId}::uuid, ${conversationId}::uuid, ${row.lastSeq}, 'agent', ${AGENT}::uuid, ${body}, ${internal})`;
  });
}

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  for (const [id, slug] of [[RESELLER_A, 'alpha'], [RESELLER_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  const base = prismaAt(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  const limits: Record<string, number> = { SUPPORT_UNFINISHED_MAX: 3 };
  support = new SupportConversationService(app, { get: (key: string) => limits[key] } as never);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

describe('opening a conversation (catalog §11.2: pick a category, type)', () => {
  it('opens async and open, with the first message as seq 1, read by its author, subject from the body', async () => {
    const opened = await as(ALICE, () => support.open(ALICE, { body: 'My config stopped working\nsince this morning' }));

    expect(opened).toMatchObject({ status: 'open', mode: 'async', subject: 'My config stopped working', unread: 0 });
    const page = await as(ALICE, () => support.messages(ALICE, opened.id, {}));
    expect(page.messages.map((m) => [m.seq, m.senderKind, m.mine])).toEqual([[1, 'user', true]]);
  });

  it('refuses a category the tenant cannot see, and caps unfinished conversations per user', async () => {
    expect(await refusal(as(AMIR, () => support.open(AMIR, { body: 'x', categoryId: '99999999-9999-4999-8999-999999999999' })))).toBe('category_unknown');

    for (let i = 0; i < 3; i++) await as(AMIR, () => support.open(AMIR, { body: `problem ${i}` }));
    expect(await refusal(as(AMIR, () => support.open(AMIR, { body: 'one more' })))).toBe('too_many_unfinished');
  });
});

describe('categories (ADR-0112 point 6)', () => {
  it("shows the platform's defaults in the caller's language until the tenant has its own, then only its own", async () => {
    const defaults = await as(ALICE, () => support.categories(ALICE, 'en'));
    expect(defaults.map((c) => c.key)).toContain('connection');
    expect(defaults.find((c) => c.key === 'connection')?.name).toBe('Connection problem');

    const own = '77777777-7777-4777-8777-7777777777b1';
    await owner.$executeRawUnsafe(`INSERT INTO support.support_category (id, "tenantId", key, "updatedAt") VALUES ('${own}', '${RESELLER_B}', 'beta_vip', now())`);
    await owner.$executeRawUnsafe(`INSERT INTO support.support_category_text ("categoryId", "tenantId", lang, name) VALUES ('${own}', '${RESELLER_B}', 'fa', 'ویژه')`);

    const theirs = await as(BEHNAZ, () => support.categories(BEHNAZ, 'en'));
    expect(theirs).toEqual([{ id: own, key: 'beta_vip', name: 'ویژه' }]);
    expect(await refusal(as(BEHNAZ, () => support.open(BEHNAZ, { body: 'x', categoryId: defaults[0].id })))).toBe('category_unknown');
    expect((await as(BEHNAZ, () => support.open(BEHNAZ, { body: 'x', categoryId: own }))).categoryId).toBe(own);
  });
});

describe('sending (ADR-0112 point 4)', () => {
  it('numbers concurrent sends 2, 3, … with no gap and no repeat', async () => {
    const opened = await as(ARASH, () => support.open(ARASH, { body: 'first' }));
    const sent = await Promise.all(
      Array.from({ length: 8 }, (_, i) => as(ARASH, () => support.send(ARASH, opened.id, { body: `burst ${i}` }))),
    );
    expect(sent.map((m) => m.seq).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("reaches no one else's conversation — another user of the same tenant, or another tenant", async () => {
    const opened = await as(ALICE, () => support.open(ALICE, { body: 'mine' }));
    for (const intruder of [AMIR, BEHNAZ]) {
      expect(await refusal(as(intruder, () => support.send(intruder, opened.id, { body: 'hi' })))).toBe('not_found');
      expect(await refusal(as(intruder, () => support.messages(intruder, opened.id, {})))).toBe('not_found');
      expect(await refusal(as(intruder, () => support.markRead(intruder, opened.id, {})))).toBe('not_found');
      const listed = await as(intruder, () => support.list(intruder, {}));
      expect(listed.items.map((c) => c.id)).not.toContain(opened.id);
    }
  });

  it('follows who wrote last: pending_user after an agent, pending_agent after the user; resolved reopens, closed refuses', async () => {
    const opened = await as(ALICE, () => support.open(ALICE, { body: 'status walk' }));
    await as(ALICE, () => support.send(ALICE, opened.id, { body: 'still waiting' }));
    expect((await as(ALICE, () => support.messages(ALICE, opened.id, {}))).conversation.status).toBe('open');

    await agentWrites(opened.id, 'on it');
    expect((await as(ALICE, () => support.messages(ALICE, opened.id, {}))).conversation.status).toBe('pending_user');
    await as(ALICE, () => support.send(ALICE, opened.id, { body: 'thanks' }));
    expect((await as(ALICE, () => support.messages(ALICE, opened.id, {}))).conversation.status).toBe('pending_agent');

    await owner.$executeRawUnsafe(`UPDATE support.conversation SET status = 'resolved', "resolvedAt" = now() WHERE id = '${opened.id}'`);
    await as(ALICE, () => support.send(ALICE, opened.id, { body: 'it broke again' }));
    const reopened = (await as(ALICE, () => support.messages(ALICE, opened.id, {}))).conversation;
    expect(reopened.status).toBe('pending_agent');

    await owner.$executeRawUnsafe(`UPDATE support.conversation SET status = 'closed', "closedAt" = now() WHERE id = '${opened.id}'`);
    expect(await refusal(as(ALICE, () => support.send(ALICE, opened.id, { body: 'hello?' })))).toBe('closed');
  });

  it('lands a message in a month nobody made a partition for', async () => {
    const opened = await as(ALICE, () => support.open(ALICE, { body: 'far future' }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2032-07-09T08:00:00.000Z'));
    try {
      const sent = await as(ALICE, () => support.send(ALICE, opened.id, { body: 'from 2032' }));
      expect(sent.createdAt.toISOString()).toBe('2032-07-09T08:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reading (ADR-0112 point 5, invariant 5)', () => {
  it("hides an agent's internal note, counts only the agent's replies as unread, and never moves the cursor back", async () => {
    const opened = await as(ROYA, () => support.open(ROYA, { body: 'read walk' }));
    await agentWrites(opened.id, 'note: check her ISP', true);
    await agentWrites(opened.id, 'Please restart the app');

    const before = await as(ROYA, () => support.list(ROYA, {}));
    expect(before.items.find((c) => c.id === opened.id)?.unread).toBe(1);

    const page = await as(ROYA, () => support.messages(ROYA, opened.id, {}));
    expect(page.messages.map((m) => m.body)).toEqual(['read walk', 'Please restart the app']);

    expect((await as(ROYA, () => support.markRead(ROYA, opened.id, {}))).lastReadSeq).toBe(3);
    expect((await as(ROYA, () => support.markRead(ROYA, opened.id, { upToSeq: 1 }))).lastReadSeq).toBe(3);
    const after = await as(ROYA, () => support.list(ROYA, {}));
    expect(after.items.find((c) => c.id === opened.id)?.unread).toBe(0);

    // Replying is reading: what the user answered is not left unread.
    await agentWrites(opened.id, 'Did it help?');
    await as(ROYA, () => support.send(ROYA, opened.id, { body: 'yes' }));
    const replied = await as(ROYA, () => support.list(ROYA, {}));
    expect(replied.items.find((c) => c.id === opened.id)?.unread).toBe(0);
  });
});
