// The panel's half of the door rules (F-066-x). auth-service's `TenantGuard`
// refuses every API call on a host that serves no panel — a `subscription` /
// `assets` domain (F-066-q), a gated reseller's platform subdomain (F-018-ag,
// F-066-x) — but this app is a separate deployable, and every host reaches it
// (F-066-u, `HostRegexp(`.+`)`). So the page rendered there even when nothing
// behind it would answer, and D-01 is about what a platform host *serves*.
//
// The rule is not restated here. `GET /api/auth/door` answers it for the host
// that asked, from the same resolution and the same gate read as the guard.
import { ProxyHeaders } from "@/generated/wire";

const TIMEOUT_MS = 2000;

/**
 * A domain verifying, or dropping back to `pending`, reaches the page within
 * this long. The API refuses from the moment the gate flips; this is only how
 * long the page lags it.
 */
const CACHE_MS = 30_000;

/**
 * Keyed by a host the visitor chose — every host reaches this app — so it is
 * bounded: past the cap it starts over rather than growing with a scan.
 */
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; serves: boolean }>();

/** For the spec. */
export function clearDoorCache() {
  cache.clear();
}

async function ask(host: string, origin: string, internal: boolean): Promise<boolean> {
  const headers: Record<string, string> = { accept: "application/json" };
  // Only on the internal hop: through the page's own origin, Traefik forwards
  // the real host itself.
  if (internal) headers[ProxyHeaders.forwardedHost] = host;

  const response = await fetch(`${origin}/api/auth/door`, {
    method: "GET",
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return true;

  const body = await response.json().catch(() => null);
  return !(body?.ok === true && body?.data?.serves === false);
}

/**
 * May `host` serve the panel? `false` only on auth-service's explicit no.
 *
 * Every doubt renders: an unregistered host (the neutral 404 — F-066-u keeps
 * the page there), a timeout, an unparseable body. The guard still refuses
 * every API call on a closed door, so failing open costs an empty shell, and
 * failing closed would take every tenant's panel down with auth-service.
 */
export async function doorServes(
  host: string,
  origin: string,
  internal: boolean,
): Promise<boolean> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.serves;
  const serves = await ask(host, origin, internal);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(host, { at: Date.now(), serves });
  return serves;
}
