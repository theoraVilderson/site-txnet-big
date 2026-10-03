/**
 * SLA (F-033-h, catalog §11.3, §11.5), against a real Postgres built from the
 * committed migration history.
 *
 * The rules the user chose (2026-10-03), and what would break silently:
 *  - targets per tenant and priority, the platform's defaults otherwise — a
 *    tenant's override leaking to another tenant reads like a good week;
 *  - counted in the tenant's working minutes on its own wall clock — a thread
 *    opened Friday night is not "late" by Saturday morning;
 *  - the resolution clock stops while the thread waits on the user, and the
 *    stopped time is given back when they answer;
 *  - the agent queue is priority, then the nearest due — a stopped clock last.
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
import type { PrismaService } from '../prisma/prisma.service';
import { SupportSla } from './sla';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const ALICE: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333a1' };
const BEHNAZ: SupportCaller = { tenantId: RESELLER_B, userId: '33333333-3333-4333-8333-3333333333b1' };
const SARA: SupportCaller = { tenantId: RESELLER_A, userId: '44444444-4444-4444-8444-4444444444a1' };
const BETA_AGENT: SupportCaller = { tenantId: RESELLER_B, userId: '44444444-4444-4444-8444-4444444444b1' };

const HOUR = 3600_000;
const tehran = (iso: string) => new Date(`${iso}+03:30`);

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let users: SupportConversationService;
let agents: SupportAgentService;
let availability: SupportAvailability;
let sla: SupportSla;

const as = <T>(caller: SupportCaller, work: () => Promise<T>) => runWithTenant({ id: caller.tenantId }, work);
const row = (id: string) => owner.supportConversation.findUniqueOrThrow({ where: { id } });

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
  const limits: Record<string, number> = { SUPPORT_UNFINISHED_MAX: 50 };
  const config = { get: (key: string) => limits[key] ?? 'x'.repeat(32) } as never;
  const realtime = { message: async () => undefined, read: async () => undefined, typing: async () => undefined, status: async () => undefined, channelProof: async () => null } as never;
  // Nobody online: every thread async. The hours still drive the SLA clock.
  const presence = { zadd: async () => undefined, zrem: async () => undefined, zrangebyscore: async () => [], zremrangebyscore: async () => undefined, expire: async () => undefined };
  availability = new SupportAvailability(app, presence);
  users = new SupportConversationService(app, config, realtime, availability);
  agents = new SupportAgentService(app, config, realtime, availability);
  sla = new SupportSla(app);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

describe('targets', () => {
  it("stamps the platform's default on open (normal: 4h to answer, 24h to resolve), no schedule = the wall clock", async () => {
    const opened = await as(ALICE, () => users.open(ALICE, { body: 'default targets' }));
    const r = await row(opened.id);
    expect(r.firstResponseDueAt!.getTime() - r.createdAt.getTime()).toBe(4 * HOUR);
    expect(r.resolutionDueAt!.getTime() - r.createdAt.getTime()).toBe(24 * HOUR);
    expect(r.slaDueAt).toEqual(r.firstResponseDueAt);
  });

  it("uses a tenant's own target for a priority, and only for that tenant; refuses a target that cannot hold", async () => {
    await as(SARA, () => sla.setTargets(RESELLER_A, [{ priority: 'normal', firstResponseMinutes: 60, resolutionMinutes: 120 }]));
    const targets = await as(SARA, () => sla.targets(RESELLER_A));
    expect(targets.find((t) => t.priority === 'normal')).toEqual({ priority: 'normal', firstResponseMinutes: 60, resolutionMinutes: 120, source: 'tenant' });
    expect(targets.find((t) => t.priority === 'urgent')).toMatchObject({ firstResponseMinutes: 30, source: 'platform' });

    const mine = await row((await as(ALICE, () => users.open(ALICE, { body: 'tenant target' }))).id);
    expect(mine.firstResponseDueAt!.getTime() - mine.createdAt.getTime()).toBe(1 * HOUR);
    const theirs = await row((await as(BEHNAZ, () => users.open(BEHNAZ, { body: 'still default' }))).id);
    expect(theirs.firstResponseDueAt!.getTime() - theirs.createdAt.getTime()).toBe(4 * HOUR);

    await expect(
      as(SARA, () => sla.setTargets(RESELLER_A, [{ priority: 'high', firstResponseMinutes: 120, resolutionMinutes: 60 }])),
    ).rejects.toBeInstanceOf(ConversationRefused);
    await as(SARA, () => sla.setTargets(RESELLER_A, []));
    expect((await as(SARA, () => sla.targets(RESELLER_A))).every((t) => t.source === 'platform')).toBe(true);
  });
});

describe('the clock', () => {
  it('counts working minutes only: urgent, opened Friday 22:00 Tehran against Sat–Wed 09–17, is due Saturday 09:30', async () => {
    await as(SARA, () =>
      availability.setHours(RESELLER_A, [6, 0, 1, 2, 3].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }))),
    );
    const opened = await as(ALICE, () => users.open(ALICE, { body: 'friday night' }));
    await owner.$executeRawUnsafe(`UPDATE support.conversation SET "createdAt" = '${tehran('2026-10-09T22:00:00').toISOString()}' WHERE id = '${opened.id}'`);

    await as(SARA, () => agents.prioritize(SARA, opened.id, { priority: 'urgent' }));
    const r = await row(opened.id);
    expect(r.priority).toBe('urgent');
    expect(r.firstResponseDueAt).toEqual(tehran('2026-10-10T09:30:00'));
    expect(r.resolutionDueAt).toEqual(tehran('2026-10-10T13:00:00'));
    await as(SARA, () => availability.setHours(RESELLER_A, []));
  });

  it("stops while waiting on the user and gives the stopped time back when they answer", async () => {
    const opened = await as(ALICE, () => users.open(ALICE, { body: 'pause walk' }));
    await as(SARA, () => agents.reply(SARA, opened.id, { body: 'Try restarting' }));
    const waiting = await row(opened.id);
    expect(waiting.slaPausedAt).not.toBeNull();
    expect(waiting.slaDueAt).toBeNull();

    // The user took two hours to answer.
    await owner.$executeRawUnsafe(`UPDATE support.conversation SET "slaPausedAt" = "slaPausedAt" - interval '2 hours' WHERE id = '${opened.id}'`);
    await as(ALICE, () => users.send(ALICE, opened.id, { body: 'still broken' }));
    const resumed = await row(opened.id);
    expect(resumed.slaPausedAt).toBeNull();
    expect(Math.round(resumed.slaPausedSeconds / 60)).toBe(120);
    expect(Math.round((resumed.resolutionDueAt!.getTime() - waiting.resolutionDueAt!.getTime()) / 60_000)).toBe(120);
    // Answered once: the clock that runs now is resolution.
    expect(resumed.slaDueAt).toEqual(resumed.resolutionDueAt);

    await as(SARA, () => agents.resolve(SARA, opened.id));
    expect((await row(opened.id)).slaDueAt).toBeNull();
  });
});

describe('the queue (catalog §11.5: priority is position)', () => {
  it('orders by priority, then the nearest due, and flags a missed first response', async () => {
    const late = await as(BEHNAZ, () => users.open(BEHNAZ, { body: 'waiting since this morning' }));
    const fresh = await as(BEHNAZ, () => users.open(BEHNAZ, { body: 'just now' }));
    const urgent = await as(BEHNAZ, () => users.open(BEHNAZ, { body: 'down' }));
    await owner.$executeRawUnsafe(`UPDATE support.conversation SET "createdAt" = now() - interval '10 hours' WHERE id = '${late.id}'`);
    await as(BETA_AGENT, () => agents.prioritize(BETA_AGENT, late.id, { priority: 'normal' }));
    await as(BETA_AGENT, () => agents.prioritize(BETA_AGENT, urgent.id, { priority: 'urgent' }));

    const page = await as(BETA_AGENT, () => agents.inbox(BETA_AGENT, { view: 'pending' }));
    const ids = page.items.map((c) => c.id);
    expect(ids.indexOf(urgent.id)).toBeLessThan(ids.indexOf(late.id));
    expect(ids.indexOf(late.id)).toBeLessThan(ids.indexOf(fresh.id));
    expect(page.items.find((c) => c.id === late.id)?.sla).toMatchObject({ firstResponseBreached: true, resolutionBreached: false });
    expect(page.items.find((c) => c.id === fresh.id)?.sla).toMatchObject({ firstResponseBreached: false });
  });
});
