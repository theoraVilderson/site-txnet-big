/**
 * Message attachments (F-033-f, ADR-0113), against a real Postgres built from
 * the committed migration history and a real local volume.
 *
 * What would break silently, and only a database can show:
 *  - a file lands private on the storage port, its message takes the next
 *    `seq`, and the read hands back a signed URL — the three writes agree;
 *  - a user cannot attach to another user's conversation, and nothing is left
 *    on the volume when they try (invariant 6);
 *  - the per-user quota counts every conversation of that user, and two
 *    uploads at once cannot both slip under it;
 *  - an infected file, or one nobody could scan, is never stored.
 *
 *   npm run test:int
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import {
  LocalObjectDriver,
  runWithTenant,
  withTenant,
  type ScanVerdict,
  type VirusScanner,
} from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import type { PrismaService } from '../prisma/prisma.service';
import { SupportAttachmentService } from './attachments.service';
import { ConversationRefused, SupportCaller, SupportConversationService } from './conversations.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const RESELLER = '11111111-1111-4111-8111-111111111111';
const ALICE: SupportCaller = { tenantId: RESELLER, userId: '33333333-3333-4333-8333-3333333333a1' };
const AMIR: SupportCaller = { tenantId: RESELLER, userId: '33333333-3333-4333-8333-3333333333a2' };
const ARASH: SupportCaller = { tenantId: RESELLER, userId: '33333333-3333-4333-8333-3333333333a3' };

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const SECRET = 'a-secret-long-enough-for-hmac-0123456789';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let root: string;
let conversations: SupportConversationService;
let attachments: SupportAttachmentService;
let verdict: ScanVerdict;

const scanner: VirusScanner = { name: 'clamd', scan: async () => verdict };

const config: Record<string, unknown> = {
  SUPPORT_UNFINISHED_MAX: 10,
  SUPPORT_ATTACHMENT_MAX_BYTES: 1000,
  SUPPORT_ATTACHMENTS_PER_MESSAGE: 3,
  SUPPORT_STORAGE_QUOTA_BYTES: 1500,
  OBJECT_STORAGE_SIGNING_SECRET: SECRET,
};
const configService = { get: (key: string) => config[key] } as never;

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

const file = (name: string, contentType: string, bytes: Buffer) => ({ originalName: name, contentType, bytes });

async function filesOnVolume(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name));
      else out.push(e.name);
    }
  };
  await walk(root);
  return out;
}

async function openFor(caller: SupportCaller, body: string) {
  return as(caller, () => conversations.open(caller, { body }));
}

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  await owner.$executeRawUnsafe(`
    INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
    VALUES ('${RESELLER}', 'reseller', '${RESELLER}', 'alpha', 'active', 'pay_as_you_go_metered', now())
  `);
  const base = prismaAt(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  root = await mkdtemp(join(tmpdir(), 'support-objects-'));
  const realtime = { message: async () => undefined, read: async () => undefined, typing: async () => undefined, tenant: async () => undefined, channelProof: async () => null } as never;
  const availability = { mode: async () => 'async' } as never;
  conversations = new SupportConversationService(app, configService, realtime, availability, { tell: async () => false } as never);
  attachments = new SupportAttachmentService(app, configService, new LocalObjectDriver(root), scanner, realtime, availability, { tell: async () => false } as never);
});

beforeEach(() => {
  verdict = { status: 'clean' };
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('attaching files to a message (catalog §11.4)', () => {
  it('stores them private, on the next seq, and the read hands back a 5-minute URL', async () => {
    const c = await openFor(ALICE, 'my invoice is wrong');
    const sent = await as(ALICE, () =>
      attachments.send(ALICE, c.id, {
        body: 'here it is',
        files: [file('Invoice ۱۴۰۵.pdf', 'application/pdf', PDF), file('shot.png', 'image/png', PNG)],
      }),
    );
    expect(sent.seq).toBe(2);
    expect(sent.attachments.map((a) => [a.fileName, a.contentType, a.sizeBytes, a.scanStatus])).toEqual([
      ['Invoice ۱۴۰۵.pdf', 'application/pdf', PDF.length, 'clean'],
      ['shot.png', 'image/png', PNG.length, 'clean'],
    ]);

    const objects = await owner.storedObject.findMany({ where: { tenantId: RESELLER } });
    expect(objects).toHaveLength(2);
    expect(objects.every((o) => o.private && o.key.startsWith(`tenants/${RESELLER}/support/${c.id}/`))).toBe(true);

    const page = await as(ALICE, () => conversations.messages(ALICE, c.id, {}));
    const [pdf] = page.messages[1].attachments;
    expect(pdf.url).toMatch(/^\/api\/public\/tenant\/private-files\/tenants\/.+\?e=\d+&n=.+&s=[0-9a-f]{64}$/);
    expect(pdf.urlExpiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it('takes files with no text, but not an empty message', async () => {
    const c = await openFor(ARASH, 'screenshots follow');
    const sent = await as(ARASH, () => attachments.send(ARASH, c.id, { files: [file('a.png', 'image/png', PNG)] }));
    expect(sent.body).toBe('');
    expect(await refusal(as(ARASH, () => attachments.send(ARASH, c.id, { body: '  ', files: [] })))).toBe('empty_message');
  });

  it("refuses another user's conversation and leaves nothing on the volume", async () => {
    const c = await openFor(ALICE, 'private matter');
    const before = await filesOnVolume();
    expect(await refusal(as(AMIR, () => attachments.send(AMIR, c.id, { files: [file('x.pdf', 'application/pdf', PDF)] })))).toBe(
      'not_found',
    );
    expect(await filesOnVolume()).toEqual(before);
  });

  it('refuses too many files, a file too large, and an HTML page called a PDF', async () => {
    const c = await openFor(AMIR, 'limits');
    const pdf = file('a.pdf', 'application/pdf', PDF);
    expect(await refusal(as(AMIR, () => attachments.send(AMIR, c.id, { files: [pdf, pdf, pdf, pdf] })))).toBe('too_many_files');
    const big = file('big.pdf', 'application/pdf', Buffer.concat([PDF, Buffer.alloc(1000)]));
    expect(await refusal(as(AMIR, () => attachments.send(AMIR, c.id, { files: [big] })))).toBe('file_too_large');
    expect(await refusal(as(AMIR, () => attachments.send(AMIR, c.id, { files: [file('x.pdf', 'application/pdf', HTML)] })))).toBe(
      'file_rejected',
    );
    expect(await refusal(as(AMIR, () => attachments.send(AMIR, c.id, { files: [file('x.svg', 'image/svg+xml', HTML)] })))).toBe(
      'file_rejected',
    );
  });

  it('never stores an infected file, nor one the scanner could not look at', async () => {
    const c = await openFor(AMIR, 'scan');
    const before = await filesOnVolume();
    verdict = { status: 'infected', signature: 'Eicar-Test-Signature' };
    expect(await refusal(as(AMIR, () => attachments.send(AMIR, c.id, { files: [file('a.pdf', 'application/pdf', PDF)] })))).toBe(
      'file_infected',
    );
    verdict = { status: 'failed', reason: 'timeout' };
    expect(await refusal(as(AMIR, () => attachments.send(AMIR, c.id, { files: [file('a.pdf', 'application/pdf', PDF)] })))).toBe(
      'scan_unavailable',
    );
    expect(await filesOnVolume()).toEqual(before);
  });
});

describe('the per-user storage quota', () => {
  it('counts every conversation of the user, and two uploads at once cannot both slip under it', async () => {
    // ALICE holds PDF + PNG (≈620 bytes) from the first test; the quota is 1500.
    const second = await openFor(ALICE, 'another thread');
    const one = file('a.pdf', 'application/pdf', PDF);
    const results = await Promise.all(
      [0, 1].map(() => refusal(as(ALICE, () => attachments.send(ALICE, second.id, { files: [one, one] })))),
    );
    expect(results.sort()).toEqual(['accepted', 'quota_exceeded']);

    // The refused upload left no bytes behind: one row per file on the volume.
    const rows = await owner.supportMessageAttachment.count({ where: { tenantId: RESELLER } });
    expect((await filesOnVolume()).length).toBe(rows);
  });

  it("is the user's own: another user of the same tenant still uploads", async () => {
    const c = await openFor(ARASH, 'mine');
    expect(await refusal(as(ARASH, () => attachments.send(ARASH, c.id, { files: [file('a.pdf', 'application/pdf', PDF)] })))).toBe(
      'accepted',
    );
  });
});

describe('the file itself, for a surface with no panel Host (F-309)', () => {
  const BAHAR: SupportCaller = { tenantId: RESELLER, userId: '33333333-3333-4333-8333-3333333333a4' };

  it("hands the bytes to the conversation's own user, and to no one else", async () => {
    const c = await openFor(BAHAR, 'for the bot');
    const sent = await as(BAHAR, () => attachments.send(BAHAR, c.id, { files: [file('رسید.pdf', 'application/pdf', PDF)] }));
    const id = sent.attachments[0].id;

    const got = await as(BAHAR, () => attachments.download(BAHAR, c.id, id));
    expect(got).toEqual({ fileName: 'رسید.pdf', contentType: 'application/pdf', bytes: PDF });
    expect(await refusal(as(AMIR, () => attachments.download(AMIR, c.id, id)))).toBe('not_found');
    // The right file under another of the user's conversations is still missing.
    const other = await openFor(BAHAR, 'another one');
    expect(await refusal(as(BAHAR, () => attachments.download(BAHAR, other.id, id)))).toBe('not_found');
  });

  it('serves only what the signed URL would: never an expired file', async () => {
    const c = await openFor(BAHAR, 'retention');
    const sent = await as(BAHAR, () => attachments.send(BAHAR, c.id, { files: [file('old.png', 'image/png', PNG)] }));
    await owner.supportMessageAttachment.update({ where: { id: sent.attachments[0].id }, data: { expiredAt: new Date(), objectKey: null } });
    expect(await refusal(as(BAHAR, () => attachments.download(BAHAR, c.id, sent.attachments[0].id)))).toBe('not_found');
  });
});
