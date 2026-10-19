import { NotFoundException } from '@nestjs/common';
import { runWithTenant, signedObjectUrl, TenantContext, type ObjectStorage } from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import { PrivateFilesController } from './files.controller';
import type { PlatformTenant } from './platform-tenant';

/**
 * A private file behind a signed URL (F-033-c, ADR-0113), by the Host that
 * asked. What breaks silently: a reseller's customer's receipt opened in that
 * reseller's workspace — which lives on the platform's panel (F-093-w) — is a
 * 404 that reads as "link expired", because the Host is the platform's and the
 * key is the reseller's. Another reseller's Host must still answer 404.
 */

const PLATFORM = '00000000-0000-4000-8000-00000000000a';
const RESELLER = '00000000-0000-4000-8000-00000000000b';
const OTHER = '00000000-0000-4000-8000-00000000000c';
const SECRET = 'a-secret-long-enough-for-hmac-0123456789';
const KEY = `tenants/${RESELLER}/transfers/p1/receipt`;

/** The storage port's own rule: it reads only the tenant in scope. */
const storage = {
  get: async (key: string) => {
    if (!key.startsWith(`tenants/${TenantContext.current('spec').id}/`)) throw new Error('TenantScopeConflict');
    return { key, private: true, contentType: 'image/png', bytes: Buffer.from('png') };
  },
} as unknown as ObjectStorage;

const controller = new PrivateFilesController(
  storage,
  { get: () => SECRET } as never,
  { id: async () => PLATFORM } as unknown as PlatformTenant,
);

function request(): Request {
  const url = new URL(signedObjectUrl({ key: KEY, fileName: 'receipt', ttlSec: 300, secret: SECRET }).url, 'http://h');
  return { params: { key: KEY.split('/') }, query: Object.fromEntries(url.searchParams) } as unknown as Request;
}

async function serveOn(door: string): Promise<number> {
  let status = 0;
  const res = { set: () => res, status: (s: number) => ((status = s), res), send: () => res } as unknown as Response;
  await runWithTenant({ id: door }, () => controller.serve(request(), res));
  return status;
}

describe('PrivateFilesController — whose Host may open a file', () => {
  it("serves it on its own tenant's Host", async () => {
    await expect(serveOn(RESELLER)).resolves.toBe(200);
  });

  it("serves a reseller's file on the platform's Host, where that reseller's workspace is", async () => {
    await expect(serveOn(PLATFORM)).resolves.toBe(200);
  });

  it("is a 404 on another reseller's Host, signature or not", async () => {
    await expect(serveOn(OTHER)).rejects.toBeInstanceOf(NotFoundException);
  });
});
