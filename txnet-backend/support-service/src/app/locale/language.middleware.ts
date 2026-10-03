import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { LocaleService } from './locale.service';

/**
 * Sets `request.language` from `Accept-Language` — the field the `shared-core`
 * envelope reads to translate `msg`. Registered before `IdentityMiddleware`, so
 * the 401 that one throws reaches the caller in their language.
 */
@Injectable()
export class LanguageMiddleware implements NestMiddleware {
  constructor(private readonly locale: LocaleService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const acceptLanguage = req.headers['accept-language'];
    (req as Request & { language?: string }).language =
      this.locale.resolveLanguage(acceptLanguage);
    next();
  }
}
