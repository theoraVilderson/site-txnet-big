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
  verifySignedObject,
} from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import type { EnvConfig } from '../config/env.validation';

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
 * Serves a stored file by its key, to the tenant whose Host asked
 * (`PublicHostMiddleware`), on its panel or its assets domain. Never a path, never a bucket URL: the key is the
 * whole address, and the driver behind it can change without this route
 * noticing.
 *
 * Answers with `@Res()`, outside the envelope — the body is the file.
 */
@Controller([FILES_PATH, LEGACY_FILES_PATH])
export class FilesController {
  constructor(private readonly storage: ObjectStorage) {}

  @Get('*key')
  @PublicRoute({ doors: ['panel', 'assets'] })
  async serve(@Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await ownFile(this.storage, keyOf(req));
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
}

/** A signed URL dies in five minutes; a cache must not keep it longer, nor share it. */
const PRIVATE_CACHE_CONTROL = 'private, max-age=300';

/** Shown in the page, not saved: the types a browser renders without running anything. */
const INLINE_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg']);

/**
 * `GET /api/public/tenant/private-files/<key>?e=&n=&s=` (F-033-c, ADR-0113):
 * a private file, to whoever holds an unexpired URL its owner's service
 * signed. The signature is the permission — the owner checked who may see the
 * file when it minted the URL — and the Host still bounds it to its tenant, so
 * a URL from one reseller's panel does not open on another's.
 *
 * Every refusal — a bad or expired signature, another tenant's key, no file —
 * is the same neutral 404.
 */
@Controller(PRIVATE_FILES_PATH)
export class PrivateFilesController {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly config: ConfigService<EnvConfig, true>,
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

    const file = await ownFile(this.storage, key);
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
}

/** The type is the one `put` checked against the bytes; a browser must not guess another, and nothing it renders may run. */
const UNRUNNABLE = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
} as const;

function keyOf(req: Request): string {
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
