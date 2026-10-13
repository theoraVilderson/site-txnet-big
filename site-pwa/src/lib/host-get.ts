// A GET to one of tenant-service's public routes, as the visitor's host.
//
// tenant-service names the tenant of a public route from `Host` (ADR-0065),
// and on the internal hop (`TENANT_SERVICE_ORIGIN`) nothing but this request
// says what that host was. Not `fetch`: it drops a `Host` header; undici's
// `request` sends it as given.
//
// Server-only: it opens a connection with `undici`.
import { request } from "undici";

/** The public routes of tenant-service, under the prefix Traefik sends there without `my-auth`. */
export const TENANT_PUBLIC = "/api/public/tenant";

/**
 * The parsed JSON body of `GET <origin><path>` sent with `Host: <host>` and no
 * cookie, or `null` for anything but a 200 with JSON: a 404, a timeout, no
 * service, a body that does not parse. Never throws.
 */
export async function getJsonAsHost(
  origin: string,
  path: string,
  host: string,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const url = new URL(path, origin);

    const { statusCode, body } = await request(url, {
      method: "GET",
      headers: {
        host,
        accept: "application/json",
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    if (statusCode !== 200) {
      // Drain the body so the keep-alive connection can be reused.
      await body.dump();
      return null;
    }

    return await body.json();
  } catch {
    // No service, a timeout or a body that is not JSON: the caller's neutral answer.
    return null;
  }
}
