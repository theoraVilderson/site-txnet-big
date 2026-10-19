import { applyDecorators, SetMetadata } from '@nestjs/common';

export const REQUIRE_CAPTCHA_KEY = 'require_captcha';
/** Set on a gated route that is also signed in — see `SignedInCaptchaGuard`. */
export const CAPTCHA_AFTER_AUTH_KEY = 'captcha_after_auth';

/**
 * Marks a route as requiring a verified `X-Captcha-Token` — see `CaptchaGuard`.
 *
 * `afterAuth` is for a route behind `AuthGuard`, which then also lists
 * `SignedInCaptchaGuard` after it: the global guard would otherwise spend the
 * pass before an expired token is refused, and the client's refresh-and-retry
 * re-sends a dead one.
 */
export const RequireCaptcha = (options: { afterAuth?: boolean } = {}) =>
  applyDecorators(
    SetMetadata(REQUIRE_CAPTCHA_KEY, true),
    ...(options.afterAuth ? [SetMetadata(CAPTCHA_AFTER_AUTH_KEY, true)] : []),
  );
