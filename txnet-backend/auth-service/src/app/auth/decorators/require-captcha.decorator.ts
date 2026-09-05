import { SetMetadata } from '@nestjs/common';

export const REQUIRE_CAPTCHA_KEY = 'require_captcha';

/** Marks a route as requiring a verified `X-Captcha-Token` — see `CaptchaGuard`. */
export const RequireCaptcha = () => SetMetadata(REQUIRE_CAPTCHA_KEY, true);
