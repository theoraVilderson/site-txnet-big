import { BotPlatform } from './bot-platform';

/**
 * The bot's URL bar (`F-314`), and one of the three real shape differences
 * between the platforms (ADR-0009's amendment). Nothing above this unit may
 * build a `t.me/...` string by hand: a hard-coded deep link is the exact
 * failure `messenger` exists to prevent.
 */

/** `https://t.me/<bot>?start=<payload>` — the same query shape on both. */
export function buildDeepLink(
  base: string,
  botUsername: string,
  payload: string,
): string {
  return `${base.replace(/\/+$/, '')}/${botUsername}?start=${encodeURIComponent(payload)}`;
}

/**
 * The default deep-link host per platform. Bale's Mini App documentation also
 * describes a `?startapp` form; the `?start=` form is what the live `F-0203`
 * flow uses on both platforms today, so it stays until something proves
 * otherwise — see `docs/platform/messenger/open-questions.md`.
 */
export const DEEP_LINK_BASE: Record<BotPlatform, string> = {
  telegram: 'https://t.me',
  bale: 'https://ble.ir',
};

/**
 * Reads `/start`, `/start <payload>`, `/start@thebot <payload>`.
 * Returns `null` when the text is not a `/start` at all, and `''` for a bare
 * `/start`, so the caller can tell "no payload" from "not this command".
 */
export function parseStart(text: string): string | null {
  const match = /^\/start(?:@\S+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!match) return null;
  return match[1] ?? '';
}

/** The payload kinds `F-314` defines, plus the `F-0203` link token already live. */
export type StartPayload =
  | { kind: 'none' }
  | { kind: 'link'; token: string }
  | { kind: 'buy'; sku: string }
  | { kind: 'ref'; code: string }
  | { kind: 'trial' }
  | { kind: 'unknown'; raw: string };

/**
 * A payload arrives from outside and is untrusted input, not a command: an
 * unrecognised one is reported as `unknown` so the caller can land the user on
 * the main menu instead of failing (`bot-app/contract.md`).
 */
export function parseStartPayload(payload: string): StartPayload {
  if (!payload) return { kind: 'none' };
  const buy = /^buy_(.+)$/.exec(payload);
  if (buy) return { kind: 'buy', sku: buy[1] };
  const ref = /^ref_(.+)$/.exec(payload);
  if (ref) return { kind: 'ref', code: ref[1] };
  if (payload === 'trial') return { kind: 'trial' };
  // Everything else is treated as an `F-0203` account-link token: that is the
  // payload shape already in production, and it is opaque by design.
  if (/^[A-Za-z0-9_-]{16,}$/.test(payload)) return { kind: 'link', token: payload };
  return { kind: 'unknown', raw: payload };
}
