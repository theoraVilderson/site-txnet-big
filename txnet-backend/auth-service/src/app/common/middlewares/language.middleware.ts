import { Injectable, NestMiddleware } from '@nestjs/common';
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
    (req as any).language = this.localeService.resolveLanguage(acceptLanguage);
    next();
  }
}
