import { BadRequestException } from '@nestjs/common';
import { I18nExceptionFilter, ResponseInterceptor } from '@txnet-backend/shared-core';

import { OfferRefused } from './decision/offers';
import { installEnvelope, offerHttpError, refusal } from './envelope';

/**
 * F-038-j0: ai-service answers in the shared envelope, as billing, tenant and
 * notification do — so the panel reads *why* ai refused (`error.reason`) and
 * shows it in the user's language, instead of "something went wrong".
 *
 * The failures worth a spec: the pair not installed (Nest's own error shape
 * reaches the panel); a refusal thrown as a bare string, which the filter
 * cannot lift into `error.reason`; an offer refusal with the wrong status.
 */

const locale = { getKey: () => undefined, getDefaultLanguage: () => 'fa' };

function through(exception: unknown) {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = { status: (s: number) => ({ json: (b: Record<string, unknown>) => ((status = s), (body = b)) }) };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST', originalUrl: '/api/ai/admin/offers' }) }) };
  new I18nExceptionFilter(locale).catch(exception, host as never);
  return { status, body };
}

describe('the shared envelope in ai-service (F-038-j0)', () => {
  it('installs the shared filter and interceptor on the app', () => {
    const app = { useGlobalFilters: vi.fn(), useGlobalInterceptors: vi.fn() };
    installEnvelope(app as never, locale);
    expect(app.useGlobalFilters).toHaveBeenCalledWith(expect.any(I18nExceptionFilter));
    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(expect.any(ResponseInterceptor));
  });

  it('a refusal reaches the client as error.reason, with its status', () => {
    expect(through(refusal(400, 'until_out_of_range'))).toMatchObject({ status: 400, body: { ok: false, error: { reason: 'until_out_of_range' } } });
  });

  it('an offer refusal: 404 for an offer not the tenant’s, 400 for a target it may not use', () => {
    expect(through(offerHttpError(new OfferRefused('offer_not_found')))).toMatchObject({ status: 404, body: { error: { reason: 'offer_not_found' } } });
    for (const reason of ['template_not_found', 'template_not_a_discount', 'variant_not_found'] as const) {
      expect(through(offerHttpError(new OfferRefused(reason)))).toMatchObject({ status: 400, body: { error: { reason } } });
    }
  });

  it('a bad body says no reason it does not have, and a bug leaks nothing', () => {
    expect(through(new BadRequestException('holdoutPercent')).body).not.toHaveProperty('error');
    const bug = through(new Error('relation "ai.offer" does not exist'));
    expect(bug.status).toBe(500);
    expect(JSON.stringify(bug.body)).not.toContain('ai.offer');
  });
});
