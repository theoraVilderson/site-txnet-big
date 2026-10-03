/**
 * Support's storage (F-033-a, ADR-0112), against a real Postgres built from
 * the committed migration history.
 *
 * Only a database can say any of it: a tenant reads its own conversations,
 * messages, read cursors and attachments and never another's (§11.6); it reads
 * the platform's default categories and its own, and cannot write a default; a
 * message lands in its month's partition, a month with no partition is an
 * error until `ensure_message_partition` — callable by the app role — makes
 * one, and the partition it makes is policied like its parent; the quiet-down
 * reader (F-1506) sees a tenant's unfinished conversations and nothing else.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-3333333333a1';
const USER_B = '33333333-3333-4333-8333-3333333333b1';

const CONV_A = '55555555-5555-4555-8555-5555555555a1';
const CONV_A_DONE = '55555555-5555-4555-8555-5555555555a2';
const CONV_B = '55555555-5555-4555-8555-5555555555b1';
const MSG_A = '66666666-6666-4666-8666-6666666666a1';
const A_CATEGORY = '77777777-7777-4777-8777-7777777777a1';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaClient;

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);

  for (const [id, type, slug] of [
    [PLATFORM, 'platform_owner', 'home'],
    [RESELLER_A, 'reseller', 'alpha'],
    [RESELLER_B, 'reseller', 'beta'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', '${type}', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  for (const [id, tenant, user, status] of [
    [CONV_A, RESELLER_A, USER_A, 'pending_agent'],
    [CONV_A_DONE, RESELLER_A, USER_A, 'closed'],
    [CONV_B, RESELLER_B, USER_B, 'open'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO support.conversation (id, "tenantId", "userId", subject, status, "lastSeq", "updatedAt")
      VALUES ('${id}', '${tenant}', '${user}', 'help', '${status}', 1, now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO support.message (id, "createdAt", "tenantId", "conversationId", seq, "senderKind", "senderUserId", body)
    VALUES ('${MSG_A}', now(), '${RESELLER_A}', '${CONV_A}', 1, 'user', '${USER_A}', 'my config is down')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO support.conversation_read ("conversationId", "userId", "tenantId", "lastReadSeq")
    VALUES ('${CONV_A}', '${USER_A}', '${RESELLER_A}', 1)
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO support.support_category (id, "tenantId", key, "updatedAt") VALUES ('${A_CATEGORY}', '${RESELLER_A}', 'alpha_only', now())
  `);

  app = prismaAt(pg.appUrl);
  app = app.$extends(withTenant(app)) as unknown as PrismaClient;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

describe('the ticket and chat tables are gone (ADR-0112 point 2)', () => {
  it('leaves one conversation model, and the impersonation link points at it', async () => {
    const [gone] = await owner.$queryRaw<{ ticket: string | null; chat: string | null }[]>`
      SELECT to_regclass('support.ticket')::text AS ticket, to_regclass('support.chat_session')::text AS chat`;
    expect(gone).toEqual({ ticket: null, chat: null });

    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO audit.impersonation_session (id, "adminId", "targetUserId", "reasonNote", "linkedConversationId", "adminIpAddress")
        VALUES (gen_random_uuid(), '${USER_A}', '${USER_A}', 'x', '99999999-9999-4999-8999-999999999999', '10.0.0.1')
      `),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('whose support rows a tenant reads (§11.6)', () => {
  it("reads its own conversations, messages and cursors — never another tenant's", async () => {
    const seen = await asTenant(RESELLER_B, async (tx) => ({
      conversations: (await tx.supportConversation.findMany({ select: { id: true } })).map((c) => c.id),
      messages: await tx.supportMessage.count(),
      reads: await tx.supportConversationRead.count(),
    }));
    expect(seen).toEqual({ conversations: [CONV_B], messages: 0, reads: 0 });

    const own = await asTenant(RESELLER_A, (tx) => tx.supportMessage.findMany({ select: { id: true } }));
    expect(own.map((m) => m.id)).toEqual([MSG_A]);
  });

  it("cannot write into another tenant's conversation", async () => {
    await expect(
      asTenant(RESELLER_B, (tx) =>
        tx.supportMessage.create({
          data: { tenantId: RESELLER_A, conversationId: CONV_A, seq: 2, senderKind: 'user', senderUserId: USER_B, body: 'x' },
        }),
      ),
    ).rejects.toThrow(/row-level security|42501/);
  });
});

describe('categories: the platform defaults and a tenant\'s own (ADR-0112 point 6)', () => {
  it('ships a default set named in every language', async () => {
    const defaults = await asTenant(RESELLER_B, (tx) =>
      tx.supportCategory.findMany({ where: { tenantId: null }, include: { texts: true } }),
    );
    expect(defaults.length).toBeGreaterThan(0);
    for (const category of defaults) {
      expect(category.texts.map((t) => t.lang).sort()).toEqual(['en', 'fa']);
    }
  });

  it("reads the defaults and its own, never another tenant's, and cannot write a default", async () => {
    const keysOf = (tenantId: string) =>
      asTenant(tenantId, async (tx) => (await tx.supportCategory.findMany({ where: { tenantId: { not: null } } })).map((c) => c.key));
    expect(await keysOf(RESELLER_A)).toEqual(['alpha_only']);
    expect(await keysOf(RESELLER_B)).toEqual([]);

    await expect(
      asTenant(RESELLER_A, (tx) => tx.supportCategory.create({ data: { tenantId: null, key: 'sneaky' } })),
    ).rejects.toThrow(/row-level security|42501/);
  });
});

describe('messages are partitioned by month (ADR-0112 point 3)', () => {
  const FAR = '2031-05-14T10:00:00.000Z';

  it('refuses a month with no partition, until the app role ensures one — policied', async () => {
    const write = () =>
      asTenant(RESELLER_A, (tx) =>
        tx.supportMessage.create({
          data: { createdAt: new Date(FAR), tenantId: RESELLER_A, conversationId: CONV_A, seq: 9, senderKind: 'user', senderUserId: USER_A, body: 'later' },
        }),
      );
    await expect(write()).rejects.toThrow(/no partition/i);

    const [made] = await app.$queryRaw<{ name: string }[]>`
      SELECT support.ensure_message_partition('2031-05-01'::date) AS name`;
    expect(made.name).toBe('message_2031_05');
    await write();

    // A partition queried by its own name is judged by its own policies.
    const [rls] = await owner.$queryRaw<{ forced: boolean }[]>`
      SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = 'support.message_2031_05'::regclass`;
    expect(rls.forced).toBe(true);
    const leaked = await asTenant(RESELLER_B, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM support.message_2031_05`,
    );
    expect(Number(leaked[0].n)).toBe(0);
  });
});

describe('the quiet-down reader reads conversations now (F-1506)', () => {
  it("sees a tenant's unfinished conversations and no other tenant's", async () => {
    const rows = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${RESELLER_A}, true)`;
      return tx.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM ai.reader_open_ticket`;
    });
    expect(rows).toEqual([{ userId: USER_A }]);
  });
});
