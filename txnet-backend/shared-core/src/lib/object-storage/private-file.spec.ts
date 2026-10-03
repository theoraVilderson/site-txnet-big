import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithTenant } from '../tenant-context/tenant-context';
import {
  LocalObjectDriver,
  ObjectRejected,
  ObjectStorage,
  type StoredObjectRow,
  type StoredObjectStore,
  type UploadPolicy,
} from './object-storage';
import { signedObjectUrl, verifySignedObject } from './signed-url';
import { ClamdScanner, scannerFromEnv } from './virus-scan';

/**
 * Private files (F-033-c, ADR-0113): a PDF is a sniffable type, a private file
 * is marked so and never served by the public route, a 5-minute signed URL is
 * the only way to one, and the bytes go past a virus scanner first.
 */

const A = '11111111-1111-4111-8111-111111111111';
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const SECRET = 'a-secret-long-enough-for-hmac-0123456789';
const KEY = `tenants/${A}/support/c1/a1.pdf`;
const NOW = new Date('2026-10-03T10:00:00Z');

const ATTACHMENT: UploadPolicy = { types: ['application/pdf', 'image/png'], maxBytes: 1024, visibility: 'private' };

function memoryStore(): StoredObjectStore & { rows: Map<string, StoredObjectRow> } {
  const rows = new Map<string, StoredObjectRow>();
  return {
    rows,
    async upsert({ where, create, update }) {
      const row = { ...(rows.get(where.key) ?? create), ...update } as StoredObjectRow;
      rows.set(where.key, row);
      return row;
    },
    async findUnique({ where }) {
      return rows.get(where.key) ?? null;
    },
    async deleteMany({ where }) {
      const had = rows.delete(where.key);
      return { count: had ? 1 : 0 };
    },
  };
}

describe('private files on the storage port (F-033-c)', () => {
  let root: string;
  let store: ReturnType<typeof memoryStore>;
  let storage: ObjectStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'objects-'));
    store = memoryStore();
    storage = new ObjectStorage(new LocalObjectDriver(root), store);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('accepts a PDF whose bytes are one, and refuses an HTML page declared a PDF', async () => {
    await runWithTenant({ id: A }, async () => {
      const put = await storage.put(ATTACHMENT, 'support/c1/a1.pdf', PDF, 'application/pdf');
      expect(store.rows.get(put.key)).toMatchObject({ contentType: 'application/pdf', private: true });
      await expect(storage.put(ATTACHMENT, 'support/c1/a2.pdf', HTML, 'application/pdf')).rejects.toEqual(
        new ObjectRejected('type_mismatch'),
      );
    });
  });

  it('records a public policy as public, so the two never share a flag by accident', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    await runWithTenant({ id: A }, async () => {
      const put = await storage.put({ types: ['image/png'], maxBytes: 64, visibility: 'public' }, 'branding/logo.png', png, 'image/png');
      expect(store.rows.get(put.key)?.private).toBe(false);
    });
  });
});

describe('signed URLs (F-033-c)', () => {
  const url = () => signedObjectUrl({ key: KEY, fileName: 'invoice.pdf', ttlSec: 300, secret: SECRET, now: NOW });
  const parts = (u: string) => {
    const parsed = new URL(u, 'https://panel.example');
    return {
      key: decodeURIComponent(parsed.pathname.replace('/api/public/tenant/private-files/', '')),
      e: parsed.searchParams.get('e') ?? '',
      n: parsed.searchParams.get('n') ?? '',
      s: parsed.searchParams.get('s') ?? '',
    };
  };

  it('is a path on the private-files route that expires five minutes on', () => {
    const { url: u, expiresAt } = url();
    expect(u.startsWith('/api/public/tenant/private-files/tenants/')).toBe(true);
    expect(expiresAt.toISOString()).toBe('2026-10-03T10:05:00.000Z');
  });

  it('verifies until it expires, and not a second after', () => {
    const p = parts(url().url);
    expect(verifySignedObject({ ...p, secret: SECRET, now: new Date('2026-10-03T10:04:59Z') })).toBe(true);
    expect(verifySignedObject({ ...p, secret: SECRET, now: new Date('2026-10-03T10:05:01Z') })).toBe(false);
  });

  it('refuses another key, another file name, a pushed-out expiry or another secret', () => {
    const p = parts(url().url);
    const ok = { ...p, secret: SECRET, now: NOW };
    expect(verifySignedObject({ ...ok, key: `tenants/${A}/support/c1/a2.pdf` })).toBe(false);
    expect(verifySignedObject({ ...ok, n: 'other.pdf' })).toBe(false);
    expect(verifySignedObject({ ...ok, e: String(Number(p.e) + 3600) })).toBe(false);
    expect(verifySignedObject({ ...ok, secret: `${SECRET}x` })).toBe(false);
    expect(verifySignedObject({ ...ok, s: 'zz' })).toBe(false);
  });

  it('refuses to sign with a short secret', () => {
    expect(() => signedObjectUrl({ key: KEY, fileName: 'x.pdf', ttlSec: 300, secret: 'short', now: NOW })).toThrow();
  });
});

describe('virus scan hook (F-033-c)', () => {
  let server: Server;
  let port: number;
  let answer: string;
  let received: Buffer;

  beforeEach(async () => {
    received = Buffer.alloc(0);
    server = createServer((socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        // The stream ends with a zero-length chunk.
        if (received.length >= 4 && received.subarray(-4).readUInt32BE(0) === 0) socket.end(answer);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('streams the bytes with INSTREAM and reads OK as clean', async () => {
    answer = 'stream: OK\0';
    const verdict = await new ClamdScanner('127.0.0.1', port, 2000).scan(PDF);
    expect(verdict).toEqual({ status: 'clean' });
    expect(received.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
    expect(received.subarray(10, 14).readUInt32BE(0)).toBe(PDF.length);
  });

  it('reads FOUND as infected, naming the signature', async () => {
    answer = 'stream: Eicar-Test-Signature FOUND\0';
    expect(await new ClamdScanner('127.0.0.1', port, 2000).scan(PDF)).toEqual({
      status: 'infected',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('is failed — never clean — when the daemon cannot be reached', async () => {
    const verdict = await new ClamdScanner('127.0.0.1', 1, 500).scan(PDF);
    expect(verdict.status).toBe('failed');
  });

  it('is chosen by the environment; an unknown driver or clamd with no address throws at boot', () => {
    expect(scannerFromEnv({ VIRUS_SCAN_DRIVER: 'none' }).name).toBe('none');
    expect(scannerFromEnv({ VIRUS_SCAN_DRIVER: 'clamd', CLAMD_ADDR: 'clamav:3310' }).name).toBe('clamd');
    expect(() => scannerFromEnv({ VIRUS_SCAN_DRIVER: 'clamd' })).toThrow();
    expect(() => scannerFromEnv({ VIRUS_SCAN_DRIVER: 'avast' })).toThrow();
  });
});
