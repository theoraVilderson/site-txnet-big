/**
 * Retention (F-033-n), against a real Postgres built from the committed
 * migration history — what the user chose on 2026-10-04 and what would break
 * silently:
 *  - an attachment's **file** goes 90 days after its conversation closed; the
 *    row stays, `expiredAt` set, no URL — never a file of an open thread or of
 *    one closed recently;
 *  - a message **month** older than 12 months is archived, one gzip JSONL per
 *    tenant on the storage port (a tenant's archive never holds another's
 *    lines), then its partition is dropped — a younger month is untouched;
 *  - the drop function is the cross-tenant role's only, and refuses a recent
 *    month whatever it is asked.
 *
 *   npm run test:int
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { PrismaClient } from '@prisma/client';
import { LocalObjectDriver, objectKey, runWithTenant, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import { SupportAttachmentService } from '../conversations/attachments.service';
import { SupportCaller, SupportConversationService } from '../conversations/conversations.service';
import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SupportRetention } from './retention';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ALICE: SupportCaller = { tenantId: A, userId: '33333333-3333-4333-8333-3333333333a1' };
const BEHNAZ: SupportCaller = { tenantId: B, userId: '33333333-3333-4333-8333-3333333333b1' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
const DAY = 86_400_000;
const NOW = new Date('2026-10-04T10:00:00Z');

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let crossTenant: CrossTenantPrismaService;
let root: string;
let driver: LocalObjectDriver;
let conversations: SupportConversationService;
let attachments: SupportAttachmentService;
let retention: SupportRetention;

const config: Record<string, unknown> = {
  SUPPORT_UNFINISHED_MAX: 10,
  SUPPORT_ATTACHMENT_MAX_BYTES: 1000,
  SUPPORT_ATTACHMENTS_PER_MESSAGE: 3,
  SUPPORT_STORAGE_QUOTA_BYTES: 100_000,
  OBJECT_STORAGE_SIGNING_SECRET: 'a-secret-long-enough-for-hmac-0123456789',
  SUPPORT_MESSAGE_RETENTION_MONTHS: 12,
  SUPPORT_ATTACHMENT_RETENTION_DAYS: 90,
};
const configService = { get: (key: string) => config[key] } as never;
const as = <T>(caller: SupportCaller, work: () => Promise<T>) => runWithTenant({ id: caller.tenantId }, work);
const partitionExists = async (name: string) =>
  (await owner.$queryRawUnsafe<{ r: string | null }[]>(`SELECT to_regclass('support.${name}')::text AS r`))[0].r !== null;

/** A thread with one PNG on its second message, then closed `daysAgo` days before NOW. */
async function closedWithFile(caller: SupportCaller, daysAgo: number | null): Promise<string> {
  const c = await as(caller, () => conversations.open(caller, { body: 'see the screenshot' }));
  await as(caller, () =>
    attachments.send(caller, c.id, { body: 'here', files: [{ originalName: 'shot.png', contentType: 'image/png', bytes: PNG }] }),
  );
  if (daysAgo !== null) {
    await owner.$executeRawUnsafe(
      `UPDATE support.conversation SET status = 'closed', "closedAt" = $1 WHERE id = $2::uuid`,
      new Date(NOW.getTime() - daysAgo * DAY),
      c.id,
    );
  }
  return c.id;
}

/** A conversation of `tenant` with `n` messages written in `month` (its partition made first). */
async function oldThread(tenant: string, userId: string, month: string, n: number): Promise<string> {
  await owner.$executeRawUnsafe(`SELECT support.ensure_message_partition('${month}-01'::date)`);
  const [{ id }] = await owner.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO support.conversation (id, "tenantId", "userId", subject, status, mode, priority, "lastSeq", "lastMessageAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'old', 'closed', 'async', 'normal', $3, '${month}-15', '${month}-15', '${month}-15') RETURNING id`,
    tenant,
    userId,
    n,
  );
  for (let seq = 1; seq <= n; seq++) {
    await owner.$executeRawUnsafe(
      `INSERT INTO support.message (id, "createdAt", "tenantId", "conversationId", seq, "senderKind", "senderUserId", body)
       VALUES (gen_random_uuid(), '${month}-15'::timestamp + ($1 || ' minutes')::interval, $2::uuid, $3::uuid, $1, 'user', $4::uuid, $5)`,
      seq,
      tenant,
      id,
      userId,
      `${tenant.slice(0, 1)} message ${seq}`,
    );
  }
  return id;
}

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  for (const [id, slug] of [[A, 'alpha'], [B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  const base = prismaAt(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  crossTenant = prismaAt(pg.crossTenantUrl) as unknown as CrossTenantPrismaService;
  root = await mkdtemp(join(tmpdir(), 'support-retention-'));
  driver = new LocalObjectDriver(root);
  const realtime = { message: async () => undefined, read: async () => undefined, typing: async () => undefined, channelProof: async () => null } as never;
  const availability = { mode: async () => 'async' } as never;
  const quiet = { tell: async () => false } as never;
  conversations = new SupportConversationService(app, configService, realtime, availability, quiet);
  attachments = new SupportAttachmentService(app, configService, driver, { name: 'clamd', scan: async () => ({ status: 'clean' }) }, realtime, availability, quiet);
  retention = new SupportRetention(app, crossTenant, configService, driver);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), crossTenant?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('attachment files (90 days after close)', () => {
  it("deletes the file of a thread closed 91 days ago, keeps the row, and leaves the others' files", async () => {
    const old = await closedWithFile(ALICE, 91);
    const recent = await closedWithFile(ALICE, 10);
    const open = await closedWithFile(BEHNAZ, null);

    const out = await retention.expireAttachments(NOW);
    expect(out.expired).toBe(1);

    const rows = await owner.supportMessageAttachment.findMany({ select: { conversationId: true, objectKey: true, expiredAt: true } });
    const of = (id: string) => rows.find((r) => r.conversationId === id)!;
    expect(of(old)).toMatchObject({ objectKey: null });
    expect(of(old).expiredAt).not.toBeNull();
    expect(of(recent).expiredAt).toBeNull();
    expect(of(open).expiredAt).toBeNull();
    expect(await owner.storedObject.count()).toBe(2);
    expect((await readdir(root, { recursive: true })).filter((f) => String(f).endsWith('.png'))).toHaveLength(2);

    // The reader is told it is gone: no URL, `expired`.
    const page = await as(ALICE, () => conversations.messages(ALICE, old, {}));
    const file = page.messages.flatMap((m) => m.attachments)[0];
    expect(file).toMatchObject({ url: null, expired: true });

    // A second run finds nothing more.
    expect((await retention.expireAttachments(NOW)).expired).toBe(0);
  });
});

describe('message months (archived, then dropped, past 12 months)', () => {
  it("archives each tenant's lines on its own, drops the month, and keeps a younger one", async () => {
    const aOld = await oldThread(A, ALICE.userId, '2025-03', 3);
    await oldThread(B, BEHNAZ.userId, '2025-03', 2);
    await oldThread(A, ALICE.userId, '2025-11', 1);
    // A file on A's first old message: its bytes, its stored_object row, its attachment row.
    const key = objectKey(A, `support/${aOld}/old.png`);
    await driver.write(key, PNG);
    await owner.$executeRawUnsafe(
      `INSERT INTO storage.stored_object (key, "tenantId", "contentType", size, sha256, private, "createdAt", "updatedAt")
       VALUES ($1, $2::uuid, 'image/png', ${PNG.length}, repeat('0', 64), true, now(), now())`,
      key,
      A,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO support.message_attachment (id, "tenantId", "conversationId", "messageId", "messageCreatedAt", "objectKey", "fileName", "contentType", "sizeBytes", "scanStatus")
       SELECT gen_random_uuid(), "tenantId", "conversationId", id, "createdAt", $1, 'old.png', 'image/png', ${PNG.length}, 'clean'
         FROM support.message WHERE "conversationId" = $2::uuid AND seq = 1`,
      key,
      aOld,
    );

    const out = await retention.archiveMonths(NOW);
    expect(out.months).toEqual(['2025-03']);
    expect(await partitionExists('message_2025_03')).toBe(false);
    expect(await partitionExists('message_2025_11')).toBe(true);

    const lines = async (tenant: string) =>
      gunzipSync(await readFile(join(root, objectKey(tenant, 'support/archive/messages-2025-03.jsonl.gz'))))
        .toString('utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
    const aLines = await lines(A);
    expect(aLines[0].attachments).toEqual([expect.objectContaining({ fileName: 'old.png', contentType: 'image/png' })]);
    // The month's files went with it: row, stored object and bytes.
    expect(await owner.supportMessageAttachment.count({ where: { conversationId: aOld } })).toBe(0);
    expect(await owner.storedObject.count({ where: { key } })).toBe(0);
    await expect(readFile(join(root, key))).rejects.toThrow();
    expect(aLines.map((l) => [l.conversationId, l.seq, l.body])).toEqual([
      [aOld, 1, '1 message 1'],
      [aOld, 2, '1 message 2'],
      [aOld, 3, '1 message 3'],
    ]);
    expect((await lines(B)).every((l) => l.tenantId === B)).toBe(true);
    expect(await owner.storedObject.count({ where: { key: { contains: 'support/archive/' } } })).toBe(2);

    // The conversation row stays: its history is in the archive.
    expect(await owner.supportConversation.count({ where: { id: aOld } })).toBe(1);
    // Nothing more is due.
    expect((await retention.archiveMonths(NOW)).months).toEqual([]);
  });

  it('the drop function refuses a recent month, and is not the app role\'s to call', async () => {
    await expect(crossTenant.$executeRawUnsafe(`SELECT support.drop_message_partition(date_trunc('month', now())::date)`)).rejects.toThrow(/recent/);
    await expect(app.$executeRawUnsafe(`SELECT support.drop_message_partition('2025-11-01'::date)`)).rejects.toThrow(/permission denied/);
    expect(await partitionExists('message_2025_11')).toBe(true);
  });
});
