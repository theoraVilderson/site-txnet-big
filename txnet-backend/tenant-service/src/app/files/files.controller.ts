import { Controller, Get, NotFoundException, Req, Res } from '@nestjs/common';
import {
  ObjectNotFound,
  ObjectStorage,
  TenantContext,
  parseObjectKey,
} from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

/** The one serving route (F-018-m): `GET /api/files/<key>`. */
export const FILES_PATH = 'files';

/**
 * Short enough that a replaced logo shows within minutes; the ETag makes every
 * revalidation after that a 304 with no bytes.
 */
const CACHE_CONTROL = 'public, max-age=300';

/**
 * Serves a stored file by its key, to the tenant whose Host asked
 * (`FileHostMiddleware`). Never a path, never a bucket URL: the key is the
 * whole address, and the driver behind it can change without this route
 * noticing.
 *
 * Answers with `@Res()`, outside the envelope — the body is the file.
 */
@Controller(FILES_PATH)
export class FilesController {
  constructor(private readonly storage: ObjectStorage) {}

  @Get('*key')
  async serve(@Req() req: Request, @Res() res: Response): Promise<void> {
    const raw = (req.params as Record<string, string | string[]>)['key'];
    const key = Array.isArray(raw) ? raw.join('/') : raw ?? '';
    // Another tenant's key is the same 404 as no key: the storage port would
    // call it a conflict, which for a stranger's URL is information.
    const parsed = parseObjectKey(key);
    if (!parsed || parsed.tenantId !== TenantContext.current('file route').id) {
      throw new NotFoundException();
    }

    let file;
    try {
      file = await this.storage.get(key);
    } catch (e) {
      if (e instanceof ObjectNotFound) throw new NotFoundException();
      throw e;
    }

    const etag = `"${file.sha256}"`;
    res.set({
      'Content-Type': file.contentType,
      ETag: etag,
      'Cache-Control': CACHE_CONTROL,
      // The type is the one `put` checked against the bytes; a browser must not
      // guess another, and nothing it renders may run.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.status(200).send(file.bytes);
  }
}
