// A GET to one of tenant-service's public routes, as the visitor's host.
//
// tenant-service names the tenant of a public route from `Host` (ADR-0065),
// and on the internal hop (`TENANT_SERVICE_ORIGIN`) nothing but this request
// says what that host was. Not `fetch`: it drops a `Host` header.
//
// Server-only: it opens a socket with `node:http`.
import http from "node:http";
import https from "node:https";

/** The public routes of tenant-service, under the prefix Traefik sends there without `my-auth`. */
export const TENANT_PUBLIC = "/api/public/tenant";

/**
 * The parsed JSON body of `GET <origin><path>` sent with `Host: <host>` and no
 * cookie, or `null` for anything but a 200 with JSON: a 404, a timeout, no
 * service, a body that does not parse. Never throws.
 */
export function getJsonAsHost(
  origin: string,
  path: string,
  host: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(path, origin);
    } catch {
      return resolve(null);
    }
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      url,
      { headers: { host, accept: "application/json" }, timeout: timeoutMs },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(raw) : null);
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}
