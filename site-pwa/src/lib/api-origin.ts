// Where the browser reaches the services: the domain the page was loaded from
// (F-066-u, ADR-0060). Traefik routes `/api/<service>` and the realtime path to
// the services on every host, so the platform's panel and every reseller's
// domain answer on their own origin, with no CORS and a first-party cookie.
//
// A path rather than a build-time origin is the whole decision. The host a call
// arrives on is what resolves its tenant (ADR-0025) and the only host its
// refresh cookie can be stored for; one `NEXT_PUBLIC_API_ORIGIN` made every
// panel talk as the platform's own host.
import { REALTIME_PATH } from "../env";

/** The prefix every service answers under, on the page's own origin. */
export const API_BASE = "/api";

/** The page's location, or the part of it a socket URL is built from. */
type PageLocation = Pick<Location, "protocol" | "host">;

/**
 * The realtime gateway's address on the page's own host: `https` -> `wss`,
 * `http` -> `ws`. Empty where there is no page (server rendering), and the
 * client then opens no socket rather than one to a guessed host.
 */
export function realtimeUrl(
  location: PageLocation | null = globalThis.location ?? null,
  path: string = REALTIME_PATH,
): string {
  if (!location?.host) return "";
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path.startsWith("/") ? path : `/${path}`}`;
}
