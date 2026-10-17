import { parsePhone } from '../../common/validation/phone.schema';

/**
 * Messengers report a contact's number in whatever shape the account was
 * registered with, and Telegram in particular drops the `+`: `989…`,
 * `+989…`, `09…` all arrive. Normalize to the E.164 form the rest of
 * identity stores (ADR-0018), or `null` if it is not a number that can hold
 * an account here.
 *
 * Two readings are tried, in this order, because they genuinely differ: a
 * bare `4915112345678` is a German number written internationally without
 * its `+`, but a bare `09121234567` is national. Reading it as national
 * first, then as international, is what makes both work without a
 * per-country branch.
 */
export function normalizeMessengerPhone(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, '');
  return (
    parsePhone(trimmed) ??
    (digits ? parsePhone(`+${digits}`) : undefined) ??
    null
  );
}
