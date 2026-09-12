/**
 * Express's `trust proxy` setting, read from the environment with the type
 * Express actually means.
 *
 * **Express reads this setting by type, and an environment variable is always
 * a string.** `app.set('trust proxy', 1)` trusts one hop;
 * `app.set('trust proxy', '1')` compiles `["1"]` as a list of trusted IP
 * addresses, matches no proxy, and leaves every `X-Forwarded-*` header
 * untrusted. Nothing throws, nothing logs, and `req.ip` / `req.hostname` /
 * `req.protocol` quietly answer from the socket and the raw `Host` instead.
 *
 * That failure hid for a long time because it is invisible from outside: a
 * request through Traefik carries the real `Host` already, so tenants resolved
 * and login worked. It only showed on the **internal** hop, where `panel-web`
 * calls auth-service directly and the true host travels in `X-Forwarded-Host`
 * (`panel-web/contract.session-guard.md`). There the host read as the
 * container name, resolved to no tenant, and the neutral 404 (ADR-0025) made
 * the auth-screen session guard fail open — a signed-in visitor was shown the
 * login screen. `req.ip` was wrong everywhere at the same time, which is what
 * an IP rate-limit bucket is keyed on.
 *
 * So the coercion is deliberate and narrow: a hop count becomes a number and a
 * boolean becomes a boolean, while **every other form stays the string Express
 * wants** — `loopback`, `uniquelocal`, or a comma-separated address list are
 * all legitimate values that must not be touched.
 */

/** One Traefik in front of every service, which is this platform's shape. */
const DEFAULT_HOPS = 1;

export function trustProxySetting(raw: string | undefined): number | boolean | string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_HOPS;

  const lowered = value.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;

  if (/^\d+$/.test(value)) return Number(value);

  // A negative count compiles to a predicate that trusts nothing — the same
  // silent failure this function exists to prevent, so it is not honoured.
  if (/^-\d+$/.test(value)) return DEFAULT_HOPS;

  // A named subnet or an address list: Express means these as written.
  return value;
}
