import { LocaleService } from '../../locale/locale.service';

/**
 * The bot's own side of the conversation. Keys live in the `notifications`
 * locale namespace under `otp.botLink.*`, alongside the OTP body itself, and
 * an English fallback keeps the flow working through a translation gap — a
 * user staring at a silent bot cannot log in.
 */
export type BotLinkMessageKey =
  | 'askContact'
  | 'askContactButton'
  | 'senderMismatch'
  | 'phoneMismatch'
  | 'expired'
  | 'takenByAnotherAccount'
  | 'noAccount'
  | 'linked'
  | 'linkedNoCode'
  | 'unknownCommand';

const FALLBACKS: Record<BotLinkMessageKey, string> = {
  askContact:
    'To receive your code here, confirm this number belongs to you by sharing your contact with the button below.',
  askContactButton: 'Share my number',
  senderMismatch:
    'That contact belongs to someone else, so it cannot confirm this account. Use the button to share your own number.',
  phoneMismatch:
    'This number is not the one the code was requested for. Start again from the site with the number you are signing in with.',
  expired:
    'This link has expired. Request the code again on the site to get a new one.',
  takenByAnotherAccount:
    'This messenger account is already linked to a different account.',
  noAccount: 'No account is registered with this number.',
  linked: 'Your number is confirmed. Your code is on its way.',
  linkedNoCode: 'Your number is confirmed. You can request your code now.',
  unknownCommand:
    'Open the link from the site to connect this messenger to your account.',
};

export function botLinkMessage(
  locale: LocaleService,
  lang: string,
  key: BotLinkMessageKey,
): string {
  // Flat dot-notation lookup against the same `notifications` namespace the
  // OTP body comes from — one file per language, one place to translate.
  const value = locale.getKey(lang, 'notifications', `otp.botLink.${key}`);
  return typeof value === 'string' && value.length > 0
    ? value
    : FALLBACKS[key];
}
