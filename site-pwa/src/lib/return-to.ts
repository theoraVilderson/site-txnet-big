import { AUTH_LOGIN, AUTH_REGISTER, PANEL_HOME } from "@/lib/routes";

/**
 * The destination a sign-in redirect bounced from (F-093-i, ADR-0042).
 *
 * The panel guard answers every failed session with `router.replace(AUTH_LOGIN)`,
 * which carries no path — so a deep link that arrives without a live session is
 * spent. A payer coming back from a bank on an expired session loses the
 * reference from the screen; a link from the bot, from an email, or to one
 * invoice all land the same way. This remembers where they were going, and the
 * sign-in screens hand it back.
 *
 * **The destination is attacker-shaped input, and this is the only risk the
 * feature adds.** An open `returnTo` on a sign-in screen is the classic
 * phishing vector: a link that takes a user through *our* login form and then
 * on to somebody else's page. So the rule is a whitelist of shape, not a
 * blacklist of strings — a stored value is a **relative path and nothing
 * else**, checked on the way in *and* on the way out, and anything else is
 * dropped in favour of the panel home.
 *
 * **`sessionStorage`, not a query parameter on the login URL.** The redirect is
 * client-side and in the same tab, so a store is enough; it keeps a payment
 * reference out of a second URL, out of history and out of any log; and it
 * leaves nothing for an outside link to forge, which a `?returnTo=` on the
 * sign-in screen would be by construction.
 *
 * This guard is a **UX redirect and not a boundary** — the panel's Traefik
 * router carries no `my-auth`, and the real gate is on the API — so nothing
 * here decides what anybody may see.
 */

/** One tab, one intent. Namespaced because `sessionStorage` is shared per origin. */
export const RETURN_TO_KEY = "txnet.returnTo";

/** Paths that would bounce the user straight back out of the panel. */
const NEVER_RETURN_TO = [AUTH_LOGIN, AUTH_REGISTER, "/auth/"];

/** A scheme, a control character or whitespace — each one a way past a validator. */
const REFUSED_CHARACTERS = /[\x00-\x20\x7f]/;

/**
 * Whether a string may be handed to `router.replace` after a sign-in.
 *
 * Every clause is one way out of this origin, and they are spelled separately
 * because each is a different mistake:
 *
 * - it must start with exactly one `/` — `//evil.example` is a
 *   protocol-relative URL and a browser reads what follows as a host;
 * - a backslash anywhere: browsers fold `\` into `/` in a URL, so `/\evil` is
 *   `//evil` by the time it is navigated;
 * - whitespace and control characters, which is how a validator gets walked
 *   past. A scheme cannot survive the first clause, and `javascript:` is a
 *   scheme.
 *
 * The auth screens are refused last: they are same-origin and safe, and
 * returning to one after signing in is only a loop.
 */
export function isSafeReturnPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  if (REFUSED_CHARACTERS.test(path)) return false;
  if (NEVER_RETURN_TO.some((prefix) => path === prefix || path.startsWith(prefix))) return false;
  return true;
}

/**
 * Remember where the user was going, if it is somewhere this app can send them.
 *
 * Called by the guards, never by a page: there is one place a session is found
 * to be missing, and the pages that redirect do not change (F-093-i).
 */
export function rememberReturnTo(path: string): void {
  if (!isSafeReturnPath(path)) return;
  write(path);
}

/** The current location, in the form this module stores. */
export function currentReturnPath(): string {
  if (typeof window === "undefined") return PANEL_HOME;
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

/**
 * Where to go now that there is a session — and forget it.
 *
 * Reading consumes, because an intent outlives nothing: the next person to sign
 * in on this tab must not land on the previous one's payment. Revalidated on
 * the way out, because between the write and this read the value has sat
 * somewhere a page's own script can reach.
 */
export function consumeReturnTo(): string {
  const stored = read();
  clearReturnTo();
  return stored && isSafeReturnPath(stored) ? stored : PANEL_HOME;
}

/** A deliberate sign-out is not a bounce: there is no intent left to return to. */
export function clearReturnTo(): void {
  try {
    window.sessionStorage.removeItem(RETURN_TO_KEY);
  } catch {
    // Private window, blocked site data, or no window at all. Nothing was
    // stored, so nothing is lost.
  }
}

function read(): string | null {
  try {
    return window.sessionStorage.getItem(RETURN_TO_KEY);
  } catch {
    return null;
  }
}

function write(path: string): void {
  try {
    window.sessionStorage.setItem(RETURN_TO_KEY, path);
  } catch {
    // Storage is a convenience here: without it the user lands on the panel
    // home, which is exactly the behaviour before this existed.
  }
}
