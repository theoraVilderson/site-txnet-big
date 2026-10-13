import { describe, expect, it } from 'vitest';

import { requestLanguage, setRequestLanguage } from './request-language';

const locale = { getDefaultLanguage: () => 'xx' };

/**
 * The language a request is answered in (CS-1-a, C-17): what each service's
 * `LanguageMiddleware` resolved from `Accept-Language`, read in one place,
 * falling back to the deployment's `DEFAULT_LANGUAGE` — never to a literal.
 * Ten controllers used to cast the request and answer `?? 'fa'`.
 */
describe('requestLanguage', () => {
  it('reads what the middleware set', () => {
    const req = {};
    setRequestLanguage(req, 'de');
    expect(requestLanguage(req, locale)).toBe('de');
  });

  it("falls back to the service's DEFAULT_LANGUAGE when the middleware never ran", () => {
    expect(requestLanguage({}, locale)).toBe('xx');
  });

  it('treats an empty language as none, as the envelope always has', () => {
    const req = {};
    setRequestLanguage(req, '');
    expect(requestLanguage(req, locale)).toBe('xx');
  });
});
