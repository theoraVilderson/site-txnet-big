/**
 * The agent's side of support (F-033-d, catalog §11.3, §11.6), against a real
 * Postgres built from the committed migration history.
 *
 * What would break silently, and only a database can show:
 *  - the inbox's four views and its queue order (priority, then the longest
 *    waiting) — a wrong `where` reads like a quiet day;
 *  - an agent reaches only its own tenant's conversations (RLS, §11.6);
 *  - a reply shares the user's `seq` counter, answers the thread
 *    (`firstResponseAt`, `pending_user`) and claims an unassigned one for the
 *    replier (user, 2026-10-03); a note does none of that and never reaches
 *    the user or the user's channel (invariant 5);
 *  - only an account of the tenant whose role holds `support.agent` can be
 *    assigned;
 *  - resolve and close follow invariant 7.
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
import { ConversationRefused, SupportCaller, SupportConversationService } from '../conversations/conversations.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SupportAgentService } from './agent.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const ALICE: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a1' };
const AMIR: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a2' };
const BEHNAZ: SupportCaller = { tenantId: RESELLER_B, userId: '33333333-3333-4333-8333-3333333333b1' };
/** Agents of A (role `Support`, `support.agent`), a plain user of A, an agent of B. */
const SARA: SupportCaller = { tenantId: RESELLER_A, userId: '44444444-4444-4444-8444-4444444444a1' };
const KAVEH: SupportCaller = { tenantId: RESELLER_A, userId: '44444444-4444-4444-8444-4444444444a2' };
const NOT_AGENT = '44444444-4444-4444-8444-4444444444a3';
const BETA_AGENT: SupportCaller = { tenantId: RESELLER_B, userId: '44444444-4444-4444-8444-4444444444b1' };

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let users: SupportConversationService;
let agents: SupportAgentService;
const published: { kind: string; conversationId: string; detail: unknown }[] = [];

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

const conversationRow = (id: string) =>
  owner.supportConversation.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  for (const [id, slug] of [[RESELLER_A, 'alpha'], [RESELLER_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  // A tenant's own `Support` role holding `support.agent` (the migration made the key), and a plain role.
  for (const [role, tenant, name, grant] of [
    ['55555555-5555-4555-8555-5555555555a1', RESELLER_A, 'Support', true],
    ['55555555-5555-4555-8555-5555555555a2', RESELLER_A, 'Member', false],
    ['55555555-5555-4555-8555-5555555555b1', RESELLER_B, 'Support', true],
  ] as const) {
    await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, "tenantId", name) VALUES ('${role}', '${tenant}', '${name}')`);
    if (grant) {
      await owner.$executeRawUnsafe(`
        INSERT INTO identity.role_permission ("roleId", "permissionId")
        SELECT '${role}', id FROM identity.permission WHERE key = 'support.agent'`);
    }
  }
  for (const [id, tenant, role] of [
    [SARA.userId, RESELLER_A, '55555555-5555-4555-8555-5555555555a1'],
    [KAVEH.userId, RESELLER_A, '55555555-5555-4555-8555-5555555555a1'],
    [NOT_AGENT, RESELLER_A, '55555555-5555-4555-8555-5555555555a2'],
    [BETA_AGENT.userId, RESELLER_B, '55555555-5555-4555-8555-5555555555b1'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity.user (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES ('${id}', '${tenant}', 'staff', 'x', '${role}', now())`);
  }

  const base = prismaAt(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  const limits: Record<string, number> = { SUPPORT_UNFINISHED_MAX: 50, OBJECT_STORAGE_SIGNING_SECRET: 0 };
  const config = { get: (key: string) => limits[key] ?? 'x'.repeat(32) } as never;
  const realtime = {
    message: async (conversationId: string, view: unknown) => void published.push({ kind: 'message', conversationId, detail: view }),
    read: async (conversationId: string, readerKind: string) => void published.push({ kind: 'read', conversationId, detail: readerKind }),
    typing: async () => undefined,
    status: async (conversationId: string, status: string) => void published.push({ kind: 'status', conversationId, detail: status }),
    channelProof: async () => null,
  } as never;
  users = new SupportConversationService(app, config, realtime);
  agents = new SupportAgentService(app, config, realtime);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

describe('the inbox (catalog §11.3: live now, pending, mine, unassigned)', () => {
  it('queues urgent first, then the longest waiting, and splits by owner and mode', async () => {
    const older = await as(ALICE, () => users.open(ALICE, { body: 'waiting longest' }));
    const urgent = await as(AMIR, () => users.open(AMIR, { body: 'everything is down' }));
    const live = await as(AMIR, () => users.open(AMIR, { body: 'chatting now' }));
    await owner.$executeRawUnsafe(`UPDATE support.conversation SET "lastMessageAt" = now() - interval '1 hour' WHERE id = '${older.id}'`);
    await owner.$executeRawUnsafe(`UPDATE support.conversation SET priority = 'urgent' WHERE id = '${urgent.id}'`);
    await owner.$executeRawUnsafe(`UPDATE support.conversation SET mode = 'live' WHERE id = '${live.id}'`);
    await as(SARA, () => agents.assign(SARA, live.id, { assigneeUserId: SARA.userId }));

    const ids = async (view: 'pending' | 'unassigned' | 'mine' | 'live', caller = SARA) =>
      (await as(caller, () => agents.inbox(caller, { view }))).items.map((c) => c.id);

    expect((await ids('pending')).slice(0, 3)).toEqual([urgent.id, older.id, live.id]);
    expect(await ids('unassigned')).not.toContain(live.id);
    expect(await ids('mine')).toEqual([live.id]);
    expect(await ids('mine', KAVEH)).toEqual([]);
    expect(await ids('live')).toEqual([live.id]);

    const item = (await as(SARA, () => agents.inbox(SARA, { view: 'pending' }))).items.find((c) => c.id === older.id);
    expect(item).toMatchObject({ userId: ALICE.userId, assignedToUserId: null, unread: 1 });
  });

  it("never shows another tenant's conversation, nor lets its agent reach one (§11.6)", async () => {
    const opened = await as(ALICE, () => users.open(ALICE, { body: 'alpha only' }));
    const theirs = await as(BETA_AGENT, () => agents.inbox(BETA_AGENT, { view: 'pending' }));
    expect(theirs.items.map((c) => c.id)).not.toContain(opened.id);
    expect(await refusal(as(BETA_AGENT, () => agents.reply(BETA_AGENT, opened.id, { body: 'hi' })))).toBe('not_found');
    expect(await refusal(as(BETA_AGENT, () => agents.messages(BETA_AGENT, opened.id, {})))).toBe('not_found');
    expect(await refusal(as(BETA_AGENT, () => agents.resolve(BETA_AGENT, opened.id)))).toBe('not_found');
  });
});

describe('replying and notes (invariants 3, 5)', () => {
  it('answers on the same seq counter, claims an unassigned thread, and publishes to the user', async () => {
    const opened = await as(ALICE, () => users.open(ALICE, { body: 'help' }));
    published.length = 0;

    const reply = await as(SARA, () => agents.reply(SARA, opened.id, { body: 'Restart the app, please' }));
    expect(reply).toMatchObject({ seq: 2, senderKind: 'agent', internal: false, mine: true });
    const row = await conversationRow(opened.id);
    expect(row).toMatchObject({ status: 'pending_user', assignedToUserId: SARA.userId });
    expect(row.firstResponseAt).not.toBeNull();
    expect(published.map((p) => p.kind)).toEqual(['message']);

    // Already someone's: another agent's reply does not take it.
    await as(KAVEH, () => agents.reply(KAVEH, opened.id, { body: 'Also check the date' }));
    expect((await conversationRow(opened.id)).assignedToUserId).toBe(SARA.userId);
  });

  it("keeps a note from the user: not on their page, not unread, not published, no status or order change", async () => {
    const opened = await as(ALICE, () => users.open(ALICE, { body: 'note walk' }));
    const before = await conversationRow(opened.id);
    published.length = 0;

    const note = await as(SARA, () => agents.reply(SARA, opened.id, { body: 'her ISP blocks UDP', internal: true }));
    expect(note).toMatchObject({ seq: 2, internal: true });
    const after = await conversationRow(opened.id);
    expect(after).toMatchObject({ status: 'open', assignedToUserId: null, firstResponseAt: null, lastSeq: 2 });
    expect(after.lastMessageAt).toEqual(before.lastMessageAt);
    expect(published).toEqual([]);

    const userPage = await as(ALICE, () => users.messages(ALICE, opened.id, {}));
    expect(userPage.messages.map((m) => m.body)).toEqual(['note walk']);
    expect(userPage.conversation.unread).toBe(0);

    const agentPage = await as(KAVEH, () => agents.messages(KAVEH, opened.id, {}));
    expect(agentPage.messages.map((m) => [m.seq, m.body, m.internal])).toEqual([
      [1, 'note walk', false],
      [2, 'her ISP blocks UDP', true],
    ]);
    expect(agentPage.conversation.userId).toBe(ALICE.userId);
  });
});

describe('assigning', () => {
  it('assigns to an agent of the tenant, refuses anyone else, and unassigns with null', async () => {
    const opened = await as(ALICE, () => users.open(ALICE, { body: 'assign walk' }));

    expect((await as(SARA, () => agents.assign(SARA, opened.id, { assigneeUserId: KAVEH.userId }))).assignedToUserId).toBe(KAVEH.userId);
    for (const stranger of [NOT_AGENT, BETA_AGENT.userId, ALICE.userId]) {
      expect(await refusal(as(SARA, () => agents.assign(SARA, opened.id, { assigneeUserId: stranger })))).toBe('assignee_unknown');
    }
    expect((await as(SARA, () => agents.assign(SARA, opened.id, { assigneeUserId: null }))).assignedToUserId).toBeNull();
  });
});

describe('resolve and close (invariant 7)', () => {
  it('resolves (the user reopens it), closes for good, and tells the channel', async () => {
    const opened = await as(ALICE, () => users.open(ALICE, { body: 'status walk' }));
    published.length = 0;

    const resolved = await as(SARA, () => agents.resolve(SARA, opened.id));
    expect(resolved.status).toBe('resolved');
    expect((await conversationRow(opened.id)).resolvedAt).not.toBeNull();
    await as(ALICE, () => users.send(ALICE, opened.id, { body: 'broke again' }));
    expect((await conversationRow(opened.id)).status).toBe('open');

    expect((await as(SARA, () => agents.close(SARA, opened.id))).status).toBe('closed');
    expect((await conversationRow(opened.id)).closedAt).not.toBeNull();
    expect(await refusal(as(SARA, () => agents.reply(SARA, opened.id, { body: 'late' })))).toBe('closed');
    expect(await refusal(as(SARA, () => agents.resolve(SARA, opened.id)))).toBe('closed');
    expect(published.filter((p) => p.kind === 'status').map((p) => p.detail)).toEqual(['resolved', 'closed']);
  });
});
