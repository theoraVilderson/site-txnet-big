import { OtpPurpose } from '../otp.interface';

/**
 * ساختار جدید برای مقادیر ترجمه
 */
export interface TranslationItem {
  text: string;
  vars: string[];
}

/**
 * Shape expected from the "otp" locale namespace
 * (locales/langs/{lang}/otp.json).
 */
export interface OtpNamespace {
  titles?: Partial<Record<OtpPurpose, TranslationItem>>;
  chatBody?: TranslationItem;
  smsBody?: TranslationItem;
}

// English fallbacks used when a locale namespace/key is missing, so OTP
// delivery never breaks just because of a translation gap.
const FALLBACK_TITLES: Record<OtpPurpose, string> = {
  [OtpPurpose.login]: 'Your login code',
  [OtpPurpose.register_phone_verify]: 'Your phone verification code',
  [OtpPurpose.password_reset]: 'Your password reset code',
};

const FALLBACK_CHAT_BODY =
  '{{title}}:\n<code>{{code}}</code>\n\nThis code is valid for 5 minutes. Do not share it with anyone.';
const FALLBACK_SMS_BODY = '{{title}}: {{code}}\nValid for 5 minutes.';

function interpolate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) =>
      acc.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value),
    template,
  );
}

function resolveTitle(
  ns: OtpNamespace | undefined,
  purpose: OtpPurpose,
): string {
  // اینجا به جای خود مقدار، فیلد text را می‌خوانیم
  return (
    ns?.titles?.[purpose]?.text ??
    FALLBACK_TITLES[purpose] ??
    'Your one-time code'
  );
}

/**
 * Builds the OTP text sent to chat-based channels (Telegram/Bale).
 * `ns` should be `LocaleService.getNamespace(lang, 'otp')` for the
 * request's resolved language; falls back to English if missing.
 */
export function buildOtpChatMessage(
  ns: OtpNamespace | undefined,
  code: string,
  purpose: OtpPurpose,
): string {
  const title = resolveTitle(ns, purpose);
  // خواندن فیلد text از chatBody
  const template = ns?.chatBody?.text ?? FALLBACK_CHAT_BODY;
  return interpolate(template, { title, code });
}

/**
 * Builds the OTP SMS template with the title resolved but `{{code}}`
 * left intact, since SmsProviderService.sendSMS does its own `{{code}}`
 * substitution via the `vars` option.
 */
export function buildOtpSmsTemplate(
  ns: OtpNamespace | undefined,
  purpose: OtpPurpose,
): string {
  const title = resolveTitle(ns, purpose);
  // خواندن فیلد text از smsBody
  const template = ns?.smsBody?.text ?? FALLBACK_SMS_BODY;
  return interpolate(template, { title });
}
