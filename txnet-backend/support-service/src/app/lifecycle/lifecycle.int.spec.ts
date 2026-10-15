/**
 * Auto-close, rating and reopen (F-033-k), against a real Postgres built from
 * the committed migration history.
 *
 * The rules the user chose (2026-10-03), and what would break silently:
 *  - a thread waiting on the user (`pending_user`) or `resolved`, with nothing
 *    from the user for 7 days, closes — one still waiting on *us* never does,
 *    or the queue empties itself;
 *  - a tenant's own days apply to that tenant only, and the sweep crosses
 *    every tenant (no request carries one);
 *  - a finished thread is rated once, 1–5 — a second rating overwriting the
 *    first reads like a happier customer;
 *  - a closed thread reopens only inside the tenant's window, back to whoever
 *    owed the next word.
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
import { SupportAgentService } from '../agent/agent.service';
import { SupportAvailability } from '../availability/availability';
import { ConversationRefused, SupportCaller, SupportConversationService } from '../conversations/conversations.service';
import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SupportLifecycle } from './lifecycle';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const ALICE: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a1' };
const AMIR: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a2' };
const BEHNAZ: SupportCaller = { tenantId: RESELLER_B, userId: '33333333-3333-4333-8333-3333333333b1' };
const SARA: SupportCaller = { tenantId: RESELLER_A, userId: '44444444-4444-4444-8444-4444444444a1' };
const BETA_AGENT: SupportCaller = { tenantId: RESELLER_B, userId: '44444444-4444-4444-8444-4444444444b1' };

const DAY = 86_400_000;

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let crossTenant: CrossTenantPrismaService;
let users: SupportConversationService;
let agents: SupportAgentService;
let lifecycle: SupportLifecycle;
const statuses: { conversationId: string; status: string }[] = [];

const as = <T>(caller: SupportCaller, work: () => Promise<T>) => runWithTenant({ id: caller.tenantId }, work);
const row = (id: string) => owner.supportConversation.findUniqueOrThrow({ where: { id } });
/** Moves every clock of a thread `days` into the past, as if it had sat that long. */
const age = (id: string, days: number) =>
  owner.$executeRawUnsafe(`
    UPDATE support.conversation
       SET "lastMessageAt" = "lastMessageAt" - interval '${days} days',
           "resolvedAt" = "resolvedAt" - interval '${days} days',
           "closedAt" = "closedAt" - interval '${days} days'
     WHERE id = '${id}'`);
const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (e) {
    if (e instanceof ConversationRefused) return e.reason;
    throw e;
  }
  return 'accepted';
};

/** A thread the user opened and an agent answered: waiting on the user. */
async function answered(user: SupportCaller, agent: SupportCaller, body: string): Promise<string> {
  const opened = await as(user, () => users.open(user, { body }));
  await as(agent, () => agents.reply(agent, opened.id, { body: 'answer' }));
  return opened.id;
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
  crossTenant = prismaAt(pg.crossTenantUrl) as unknown as CrossTenantPrismaService;
  const limits: Record<string, number> = { SUPPORT_UNFINISHED_MAX: 50 };
  const config = { get: (key: string) => limits[key] ?? 'x'.repeat(32) } as never;
  const realtime = {
    message: async () => undefined,
    read: async () => undefined,
    typing: async () => undefined,
    tenant: async () => undefined,
    status: async (conversationId: string, status: string) => void statuses.push({ conversationId, status }),
    channelProof: async () => null,
  } as never;
  const presence = { zadd: async () => undefined, zrem: async () => undefined, zrangebyscore: async () => [], zremrangebyscore: async () => undefined, expire: async () => undefined };
  const availability = new SupportAvailability(app, presence);
  const quiet = { tell: async () => false } as never;
  users = new SupportConversationService(app, config, realtime, availability, quiet);
  agents = new SupportAgentService(app, config, realtime, availability, quiet);
  lifecycle = new SupportLifecycle(app, crossTenant, config, realtime);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), crossTenant?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

describe('the policy', () => {
  it("is the platform's 7/7 until a tenant sets its own, and a tenant's never reaches another", async () => {
    expect(await as(SARA, () => lifecycle.policy(RESELLER_A))).toEqual({ autoCloseAfterDays: 7, reopenWithinDays: 7, source: 'platform' });
    await as(BETA_AGENT, () => lifecycle.setPolicy(RESELLER_B, { autoCloseAfterDays: 2, reopenWithinDays: 0 }));
    expect(await as(BETA_AGENT, () => lifecycle.policy(RESELLER_B))).toEqual({ autoCloseAfterDays: 2, reopenWithinDays: 0, source: 'tenant' });
    expect((await as(SARA, () => lifecycle.policy(RESELLER_A))).source).toBe('platform');
    expect(await refusal(as(SARA, () => lifecycle.setPolicy(RESELLER_A, { autoCloseAfterDays: 0, reopenWithinDays: 7 })))).toBe('lifecycle_invalid');
  });
});

describe('auto-close', () => {
  it("closes threads idle on the user's side past their tenant's days, across tenants, and nothing else", async () => {
    const waitingOld = await answered(ALICE, SARA, 'waiting on Alice for 8 days');
    await age(waitingOld, 8);
    const resolvedOld = await answered(ALICE, SARA, 'resolved 8 days ago');
    await as(SARA, () => agents.resolve(SARA, resolvedOld));
    await age(resolvedOld, 8);
    const oursOld = await answered(ALICE, SARA, 'Alice wrote last, 8 days ago');
    await as(ALICE, () => users.send(ALICE, oursOld, { body: 'still broken' }));
    await age(oursOld, 8);
    const waitingNew = await answered(ALICE, SARA, 'waiting on Alice for 3 days');
    await age(waitingNew, 3);
    // B closes after 2 days.
    const betaWaiting = await answered(BEHNAZ, BETA_AGENT, 'waiting on Behnaz for 3 days');
    await age(betaWaiting, 3);
    statuses.length = 0;

    const result = await lifecycle.closeIdle(new Date());

    expect(result.closed).toBe(3);
    for (const id of [waitingOld, resolvedOld, betaWaiting]) {
      expect(await row(id)).toMatchObject({ status: 'closed', closedAutomatically: true, slaDueAt: null });
    }
    expect((await row(oursOld)).status).toBe('pending_agent');
    expect((await row(waitingNew)).status).toBe('pending_user');
    expect(statuses.map((s) => s.conversationId).sort()).toEqual([waitingOld, resolvedOld, betaWaiting].sort());
    expect(statuses.every((s) => s.status === 'closed')).toBe(true);

    // Run twice: nothing more to close.
    expect((await lifecycle.closeIdle(new Date())).closed).toBe(0);
  });
});

describe('rating', () => {
  it('takes one 1–5 score on a finished thread, from its own user only', async () => {
    const id = await answered(ALICE, SARA, 'rate me');
    expect(await refusal(as(ALICE, () => lifecycle.rate(ALICE, id, { score: 5 })))).toBe('not_finished');

    await as(SARA, () => agents.resolve(SARA, id));
    expect(await refusal(as(AMIR, () => lifecycle.rate(AMIR, id, { score: 1 })))).toBe('not_found');
    const rated = await as(ALICE, () => lifecycle.rate(ALICE, id, { score: 4, comment: 'fast, thanks' }));
    expect(rated).toMatchObject({ score: 4, comment: 'fast, thanks' });
    expect(await refusal(as(ALICE, () => lifecycle.rate(ALICE, id, { score: 1 })))).toBe('already_rated');
    expect(await row(id)).toMatchObject({ ratingScore: 4, ratingComment: 'fast, thanks' });
  });
});

describe('reopen', () => {
  it("reopens a closed thread inside the tenant's window to whoever owed the next word, and refuses past it", async () => {
    const id = await answered(ALICE, SARA, 'reopen me');
    expect(await refusal(as(ALICE, () => lifecycle.reopen(ALICE, id)))).toBe('not_closed');
    await as(SARA, () => agents.close(SARA, id));
    await age(id, 6);

    const reopened = await as(ALICE, () => lifecycle.reopen(ALICE, id));
    expect(reopened.status).toBe('pending_agent');
    const r = await row(id);
    expect(r).toMatchObject({ status: 'pending_agent', closedAt: null, resolvedAt: null, closedAutomatically: false });
    expect(r.slaDueAt).not.toBeNull();

    await as(SARA, () => agents.close(SARA, id));
    await age(id, 8);
    expect(await refusal(as(ALICE, () => lifecycle.reopen(ALICE, id)))).toBe('reopen_expired');

    // B's window is 0 days: a closed thread there is final.
    const beta = await answered(BEHNAZ, BETA_AGENT, 'beta closes for good');
    await as(BETA_AGENT, () => agents.close(BETA_AGENT, beta));
    expect(await refusal(as(BEHNAZ, () => lifecycle.reopen(BEHNAZ, beta)))).toBe('reopen_expired');
  });
});
