import { Injectable, NestMiddleware } from '@nestjs/common';
import { setRequestLanguage } from '@txnet-backend/shared-core';
import { Request, Response, NextFunction } from 'express';
import { LocaleService } from '../../locale/locale.service';

/**
 * Sets the request language based on Accept-Language header.
 */
@Injectable()
export class LanguageMiddleware implements NestMiddleware {
  constructor(private readonly localeService: LocaleService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const acceptLanguage = req.headers['accept-language'] as string | undefined;
    setRequestLanguage(req, this.localeService.resolveLanguage(acceptLanguage));
    next();
  }
}
