import { BadRequestException, HttpException, NotFoundException, type INestApplication } from '@nestjs/common';
import { I18nExceptionFilter, ResponseInterceptor, type EnvelopeTranslator } from '@txnet-backend/shared-core';

import type { OfferRefused } from './decision/offers';

/**
 * F-038-j0: the shared envelope, the pair billing, tenant and notification
 * install — the filter translates what is thrown, the interceptor what is
 * returned. A refusal the client acts on travels as `error.reason`; `msg` is
 * for the eye, in the caller's language (`LanguageMiddleware`).
 */
export function installEnvelope(app: Pick<INestApplication, 'useGlobalFilters' | 'useGlobalInterceptors'>, locale: EnvelopeTranslator): void {
  app.useGlobalFilters(new I18nExceptionFilter(locale));
  app.useGlobalInterceptors(new ResponseInterceptor(locale));
}

/** A refusal with its reason as an object — a bare string is never lifted into `error.reason`. */
export function refusal(status: 400 | 404, reason: string): HttpException {
  const body = { reason, message: reason };
  return status === 404 ? new NotFoundException(body) : new BadRequestException(body);
}

/** An offer refusal (F-038-f1): 404 for an offer not the tenant's, 400 for a target it may not use. */
export function offerHttpError(err: OfferRefused): HttpException {
  return refusal(err.reason === 'offer_not_found' ? 404 : 400, err.reason);
}
