import { Injectable, NestMiddleware } from '@nestjs/common';
import { setRequestLanguage } from '@txnet-backend/shared-core';
import type { NextFunction, Request, Response } from 'express';

import { LocaleService } from './locale.service';

/**
 * Sets `request.language` from `Accept-Language` — the field the `shared-core`
 * envelope reads to translate `msg` (F-038-j0). Registered before
 * `IdentityMiddleware`, so its 401 reaches the caller in their language.
 */
@Injectable()
export class LanguageMiddleware implements NestMiddleware {
  constructor(private readonly locale: LocaleService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    setRequestLanguage(req, this.locale.resolveLanguage(req.headers['accept-language']));
    next();
  }
}
