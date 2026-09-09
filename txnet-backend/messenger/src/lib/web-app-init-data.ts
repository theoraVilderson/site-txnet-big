import { createHmac, timingSafeEqual } from 'crypto';
import { BotPlatform } from './bot-platform';

/**
 * The Mini App's proof of who is looking at it (`F-310`).
 *
 * A WebApp is an ordinary web page in a webview, so nothing about the request
 * itself says which messenger account opened it — a page can be opened in any
 * browser by anyone. What the platform hands the page instead is `initData`: a
 * query string it signed with the bot's own token. Verifying that signature is
 * the whole of the proof, and it is a **wire fact about a platform**, which is
 * why it lives here and not in `identity`: this unit is the only place that
 * holds a bot token, and the rule about what the proof then *entitles* someone
 * to is `identity`'s (ADR-0017).
 *
 * The scheme is the same on both platforms (`docs/platform/messenger/contract.md`,
 * verified 2026-09-05):
 *
 *   secret = HMAC-SHA-256("WebAppData", <bot token>)
 *   hash   = HMAC-SHA-256(secret, <data-check-string>)
 *
 * where the data-check-string is every field except `hash`, as `key=value`,
 * sorted by key, joined with `\n`.
 */

export interface WebAppUser {
  /** The platform's own id for this person — the same number a private chat
   * carries as its `chat.id`, which is what `LinkedBotAccount` stores. */
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}

export interface WebAppInitData {
  platform: BotPlatform;
  user: WebAppUser;
  /** When the platform signed it, as epoch seconds. */
  authDate: number;
  /** The `?startapp=` / `?start=` payload, when the app was opened by one. */
  startParam?: string;
}

/**
 * How old a signature may be and still be accepted.
 *
 * `initData` is signed once, when the app opens, and the page may then sit
 * open for as long as the user leaves it open — so this is not a session
 * length, it is the window in which a *replayed* string still works. A day is
 * the vendor's own suggestion and far too generous for something that mints a
 * session; an hour covers opening the app, reading a message and coming back,
 * and a page older than that simply asks the platform for fresh `initData`.
 */
export const WEB_APP_INIT_DATA_MAX_AGE_SEC = 3600;

export type WebAppInitDataFailure =
  | 'malformed'
  | 'badSignature'
  | 'expired'
  | 'noUser';

/**
 * Both halves declare both fields — the absent one as `undefined` — because
 * this workspace compiles without `strictNullChecks`, and without it a
 * `boolean` discriminant narrows nothing: `if (!result.ok)` would leave
 * `reason` unreadable. Declaring the shape fully is cheaper than a cast at
 * every call site, and it is the same fact either way.
 */
export type WebAppInitDataResult =
  | { ok: true; data: WebAppInitData; reason?: undefined }
  | { ok: false; reason: WebAppInitDataFailure; data?: undefined };

/**
 * Verify `initData` against a bot token.
 *
 * Returns a reason rather than throwing, because every failure here is an
 * ordinary answer to an untrusted string: the caller turns all of them into
 * the same refusal, and only the log distinguishes them.
 */
export function verifyWebAppInitData(
  platform: BotPlatform,
  token: string,
  initData: string,
  maxAgeSec: number = WEB_APP_INIT_DATA_MAX_AGE_SEC,
  now: Date = new Date(),
): WebAppInitDataResult {
  if (!token || !initData) return { ok: false, reason: 'malformed' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'malformed' };

  // Every field except `hash`, `key=value`, sorted, newline-joined. Built from
  // the *decoded* values, which is what the platform signed.
  const checkString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');
  if (!hexEqual(hash, expected)) return { ok: false, reason: 'badSignature' };

  // Only past this point is anything in the string worth reading.
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  const ageSec = Math.floor(now.getTime() / 1000) - authDate;
  if (ageSec > maxAgeSec) return { ok: false, reason: 'expired' };

  const user = parseUser(params.get('user'));
  if (!user) return { ok: false, reason: 'noUser' };

  const startParam = params.get('start_param') ?? undefined;
  return {
    ok: true,
    data: { platform, user, authDate, ...(startParam ? { startParam } : {}) },
  };
}

/** The `user` field is a JSON object, and it is signed along with the rest. */
function parseUser(raw: string | null): WebAppUser | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || (typeof parsed.id !== 'number' && typeof parsed.id !== 'string')) {
    return null;
  }
  return {
    id: String(parsed.id),
    firstName: str(parsed.first_name),
    lastName: str(parsed.last_name),
    username: str(parsed.username),
    languageCode: str(parsed.language_code),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Constant-time compare of two hex digests, tolerating a length mismatch. */
function hexEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given.toLowerCase(), 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
