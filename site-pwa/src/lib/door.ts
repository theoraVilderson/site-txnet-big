// The panel's half of the door rules (F-066-x). auth-service's `TenantGuard`
// refuses every API call on a host that serves no panel — a `subscription` /
// `assets` domain (F-066-q), a gated reseller's platform subdomain (F-018-ag,
// F-066-x) — but this app is a separate deployable, and every host reaches it
// (F-066-u, `HostRegexp(`.+`)`). So the page rendered there even when nothing
// behind it would answer, and D-01 is about what a platform host *serves*.
//
// The rule is not restated here. `GET /api/public/tenant/serves-panel`
// answers it for the host that asked, from the same shared-core rule the API's
// guards refuse on (F-018-ak, ADR-0065).
import { TENANT_PUBLIC, getJsonAsHost } from "./host-get";

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

async function ask(host: string, origin: string): Promise<boolean> {
  const body = (await getJsonAsHost(origin, `${TENANT_PUBLIC}/serves-panel`, host, TIMEOUT_MS)) as {
    ok?: unknown;
    data?: { serves?: unknown };
  } | null;
  return !(body?.ok === true && body?.data?.serves === false);
}

/**
 * May `host` serve the panel? `false` only on tenant-service's explicit no.
 *
 * Every doubt renders: an unregistered host (the neutral 404 — F-066-u keeps
 * the page there), a timeout, an unparseable body. The guard still refuses
 * every API call on a closed door, so failing open costs an empty shell, and
 * failing closed would take every tenant's panel down with tenant-service.
 *
 * `origin` is `TENANT_SERVICE_ORIGIN` (the internal hop), else the page's own
 * origin, where Traefik routes `/api/public/tenant` on every host.
 */
export async function doorServes(host: string, origin: string): Promise<boolean> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.serves;
  const serves = await ask(host, origin);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(host, { at: Date.now(), serves });
  return serves;
}
