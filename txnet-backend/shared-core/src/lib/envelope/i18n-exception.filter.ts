import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';
import type { EnvelopeTranslator } from './response';
import { sanitizeError } from './sanitize-error';

/**
 * Global catch-all filter. Every thrown value — HttpException, Prisma error,
 * third-party failure, plain bug — goes through {@link sanitizeError}, so the
 * client only ever receives:
 *
 *   { ok: false, msg: "<translated safe message>", ref: "<id>", fieldErrors?: [...] }
 *
 * The real error (message, stack, DB code/meta) is written to the server log
 * only, correlated by `ref`.
 */
@Catch()
export class I18nExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly localeService: EnvelopeTranslator) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const safe = sanitizeError(exception);
    const lang =
      (request as unknown as { language?: string }).language ||
      this.localeService.getDefaultLanguage();
    const translate = (key: string) =>
      this.localeService.getKey(lang, 'errors', key) || key;

    // The only place the real error is recorded.
    const line = `[${safe.ref}] ${request.method} ${request.originalUrl} -> ${safe.status} ${safe.msgKey} :: ${safe.detail}`;
    if (safe.logLevel === 'error') this.logger.error(line);
    else this.logger.warn(line);

    const body: Record<string, unknown> = {
      ok: false,
      msg: translate(safe.msgKey),
      ref: safe.ref,
    };
    // What a client acts on without reading `msg` (ADR-0043). Absent unless
    // the throw named one, so no existing answer changes shape.
    if (safe.reason) body['error'] = { reason: safe.reason };
    if (safe.fieldErrors?.length) {
      body['fieldErrors'] = safe.fieldErrors.map((f) => ({
        path: f.path,
        message: translate(f.i18nKey),
      }));
    }

    response.status(safe.status).json(body);
  }
}
