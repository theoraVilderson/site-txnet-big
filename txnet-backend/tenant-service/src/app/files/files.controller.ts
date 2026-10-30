import { Controller, Get, NotFoundException, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ObjectNotFound,
  ObjectStorage,
  PRIVATE_FILES_PATH,
  PublicRoute,
  StoredObjectRow,
  TenantContext,
  parseObjectKey,
  publicPath,
  runWithTenant,
  verifySignedObject,
} from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import type { EnvConfig } from '../config/env.validation';
import { PlatformTenant } from './platform-tenant';

/** The one serving route (F-018-m): `GET /api/public/tenant/files/<key>` (F-018-ak). */
export const FILES_PATH = publicPath('tenant', 'files');

/** @deprecated since 2026-09-19, remove after the next release: `GET /api/files/<key>`, before ADR-0065. */
export const LEGACY_FILES_PATH = 'files';

/**
 * Short enough that a replaced logo shows within minutes; the ETag makes every
 * revalidation after that a 304 with no bytes.
 */
const CACHE_CONTROL = 'public, max-age=300';

/**
 * The platform's public files every Host serves, besides its own (ADR-0117
 * point 2): its guides' images, which every reseller inherits with the guides.
 * Nothing else of the platform's — its branding stays its own — and never a
 * private file, which only `private-files` serves.
 */
export const PLATFORM_SHARED_PREFIXES = ['guides/'] as const;

/**
 * Serves a stored file by its key, to the tenant whose Host asked
 * (`PublicHostMiddleware`), on its panel or its assets domain. Never a path, never a bucket URL: the key is the
 * whole address, and the driver behind it can change without this route
 * noticing.
 *
 * Answers with `@Res()`, outside the envelope — the body is the file.
 */
@Controller([FILES_PATH, LEGACY_FILES_PATH])
export class FilesController {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly platform: PlatformTenant,
  ) {}

  @Get('*key')
  @PublicRoute({ doors: ['panel', 'assets'] })
  async serve(@Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.served(keyOf(req));
    // A private file has no public address (ADR-0113): it answers here exactly
    // as a missing one, and only `private-files` with a signature serves it.
    if (file.private) throw new NotFoundException();

    const etag = `"${file.sha256}"`;
    res.set({ 'Content-Type': file.contentType, ETag: etag, 'Cache-Control': CACHE_CONTROL, ...UNRUNNABLE });
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.status(200).send(file.bytes);
  }

  /** The Host's own file, or the platform's under a shared prefix — read in the platform's scope, as the port requires. */
  private async served(key: string): Promise<StoredObjectRow & { bytes: Buffer }> {
    const parsed = parseObjectKey(key);
    if (
      parsed &&
      parsed.tenantId !== TenantContext.current('file route').id &&
      PLATFORM_SHARED_PREFIXES.some((p) => parsed.path.startsWith(p)) &&
      parsed.tenantId === (await this.platform.id())
    ) {
      return runWithTenant({ id: parsed.tenantId }, () => ownFile(this.storage, key));
    }
    return ownFile(this.storage, key);
  }
}

/** A signed URL dies in five minutes; a cache must not keep it longer, nor share it. */
const PRIVATE_CACHE_CONTROL = 'private, max-age=300';

/** Shown in the page, not saved: the types a browser renders without running anything. */
const INLINE_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg']);

/**
 * `GET /api/public/tenant/private-files/<key>?e=&n=&s=` (F-033-c, ADR-0113):
 * a private file, to whoever holds an unexpired URL its owner's service
 * signed. The signature is the permission — the owner checked who may see the
 * file when it minted the URL — and the Host still bounds it: its own tenant's,
 * or the platform's, whose panel hosts every reseller's workspace (F-093-w) —
 * a reseller's customer's receipt is reviewed there. A URL from one reseller's
 * panel still does not open on another's.
 *
 * Every refusal — a bad or expired signature, another tenant's key, no file —
 * is the same neutral 404.
 */
@Controller(PRIVATE_FILES_PATH)
export class PrivateFilesController {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly platform: PlatformTenant,
  ) {}

  @Get('*key')
  @PublicRoute({ doors: ['panel', 'assets'] })
  async serve(@Req() req: Request, @Res() res: Response): Promise<void> {
    const key = keyOf(req);
    const q = req.query as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const signed = verifySignedObject({
      key,
      e: str(q['e']),
      n: str(q['n']),
      s: str(q['s']),
      secret: this.config.get('OBJECT_STORAGE_SIGNING_SECRET', { infer: true }),
    });
    if (!signed) throw new NotFoundException();

    const file = await this.signedFile(key);
    if (!file.private) throw new NotFoundException();

    const disposition = INLINE_TYPES.has(file.contentType) ? 'inline' : 'attachment';
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(str(q['n']))}`,
      'Cache-Control': PRIVATE_CACHE_CONTROL,
      'Referrer-Policy': 'no-referrer',
      ...UNRUNNABLE,
    });
    res.status(200).send(file.bytes);
  }

  /** The Host's own file, or — on the platform's Host — any tenant's, read in that tenant's scope as the port requires. */
  private async signedFile(key: string): Promise<StoredObjectRow & { bytes: Buffer }> {
    const parsed = parseObjectKey(key);
    const door = TenantContext.current('private file route').id;
    if (parsed && parsed.tenantId !== door && door === (await this.platform.id())) {
      return runWithTenant({ id: parsed.tenantId }, () => ownFile(this.storage, key));
    }
    return ownFile(this.storage, key);
  }
}

/** The type is the one `put` checked against the bytes; a browser must not guess another, and nothing it renders may run. */
const UNRUNNABLE = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
} as const;

/** A stored file's key from a route's `*key` wildcard. */
export function keyOf(req: Request): string {
  const raw = (req.params as Record<string, string | string[]>)['key'];
  return Array.isArray(raw) ? raw.join('/') : raw ?? '';
}

/**
 * The file at `key` in the Host's tenant. Another tenant's key is the same 404
 * as no key: the storage port would call it a conflict, which for a
 * stranger's URL is information.
 */
async function ownFile(storage: ObjectStorage, key: string): Promise<StoredObjectRow & { bytes: Buffer }> {
  const parsed = parseObjectKey(key);
  if (!parsed || parsed.tenantId !== TenantContext.current('file route').id) {
    throw new NotFoundException();
  }
  try {
    return await storage.get(key);
  } catch (e) {
    if (e instanceof ObjectNotFound) throw new NotFoundException();
    throw e;
  }
}
