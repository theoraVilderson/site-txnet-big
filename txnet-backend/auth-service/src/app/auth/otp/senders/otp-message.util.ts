import { OtpPurpose } from '../otp.interface';

/**
 * Shape of the `notifications` locale namespace this module reads
 * (`locales/backend/langs/<lang>/notifications.json`). locale-service hands
 * namespaces back as flat dot-notation keys and `LocaleService.getNamespace`
 * re-nests them, so `otp.title.login` arrives as `otp.title.login` — a plain
 * string, not an object.
 */
export interface OtpNamespace {
  otp?: {
    title?: Partial<Record<OtpPurpose, string>>;
    chatBody?: string;
    smsBody?: string;
  };
}

// English fallbacks used when a locale namespace/key is missing, so OTP
// delivery never breaks just because of a translation gap.
const FALLBACK_TITLES: Record<OtpPurpose, string> = {
  [OtpPurpose.login]: 'Your login code',
  [OtpPurpose.register_phone_verify]: 'Your phone verification code',
  [OtpPurpose.password_reset]: 'Your password reset code',
  [OtpPurpose.account_link]: 'Your account linking code',
  [OtpPurpose.account_switch_link]: 'Your code to add this account',
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
  return (
    ns?.otp?.title?.[purpose] ?? FALLBACK_TITLES[purpose] ?? 'Your one-time code'
  );
}

/**
 * Builds the OTP text sent to chat-based channels (Telegram/Bale).
 * `ns` should be `LocaleService.getNamespace(lang, 'notifications')` for the
 * request's resolved language; falls back to English if missing.
 */
export function buildOtpChatMessage(
  ns: OtpNamespace | undefined,
  code: string,
  purpose: OtpPurpose,
): string {
  const title = resolveTitle(ns, purpose);
  const template = ns?.otp?.chatBody ?? FALLBACK_CHAT_BODY;
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
  const template = ns?.otp?.smsBody ?? FALLBACK_SMS_BODY;
  return interpolate(template, { title });
}
