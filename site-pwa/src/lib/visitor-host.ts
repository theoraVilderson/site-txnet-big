// The host the visitor is on — the one Traefik forwarded to this app, else
// `Host`, else the caller's fallback. Every server-side read that names a
// tenant by host starts here: the session guard (`proxy.ts`, F-066-r) and the
// brand (`branding.ts`, F-066-v).
import { ProxyHeaders } from "@/generated/wire";

export function visitorHost(
  headers: Headers,
  fallback?: string,
): string | null {
  const forwardedHostHeader = headers.get(ProxyHeaders.forwardedHost);
  const forwardedHost = forwardedHostHeader?.split(",")[0].trim();
  const hostHeader = headers.get("host");
  const host = forwardedHost || hostHeader || fallback;

  if (!host) return null;

  const hostWithOutPort = host.replace(/:\d+$/, "");

  return hostWithOutPort;
}
