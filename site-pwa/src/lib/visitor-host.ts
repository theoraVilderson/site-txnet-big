// The host the visitor is on — the one Traefik forwarded to this app, else
// `Host`, else the caller's fallback. Every server-side read that names a
// tenant by host starts here: the session guard (`proxy.ts`, F-066-r) and the
// brand (`branding.ts`, F-066-v).
import { ProxyHeaders } from "@/generated/wire";

export function visitorHost(headers: Headers, fallback?: string): string | null {
  const forwarded = headers.get(ProxyHeaders.forwardedHost);
  const host = forwarded?.split(",")[0]?.trim() || headers.get("host") || fallback;
  return host || null;
}
