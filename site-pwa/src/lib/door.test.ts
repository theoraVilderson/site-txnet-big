// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyHeaders } from "@/generated/wire";
import { clearDoorCache, doorServes } from "./door";

/**
 * The panel's half of the door rules (F-066-x): `site-pwa` renders nothing on
 * a host auth-service says serves no panel — a `subscription` / `assets`
 * domain, or a gated reseller's platform subdomain.
 *
 * Every doubt ends in rendering: an unregistered host (auth-service's neutral
 * 404, F-066-u's own call), an unreachable service, a body that does not
 * parse. The server-side guard still refuses every API call there, so the
 * worst case is an empty shell, never data.
 */
const INTERNAL = "http://auth-service:3000";

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearDoorCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("doorServes", () => {
  it("is closed when auth-service says so", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, data: { serves: false } }));
    await expect(doorServes("acme.txnet.example", INTERNAL, true)).resolves.toBe(false);
  });

  it("is open when auth-service says so", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, data: { serves: true } }));
    await expect(doorServes("shop.acme.com", INTERNAL, true)).resolves.toBe(true);
  });

  it.each([
    ["an unregistered host (the neutral 404)", () => answer(404, { ok: false })],
    ["an unparseable body", () => new Response("<html>", { status: 200 })],
    ["an envelope with no verdict", () => answer(200, { ok: true, data: {} })],
  ])("renders on %s", async (_label, respond) => {
    fetchMock.mockResolvedValue(respond());
    await expect(doorServes("x.example", INTERNAL, true)).resolves.toBe(true);
  });

  it("renders when auth-service cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(doorServes("x.example", INTERNAL, true)).resolves.toBe(true);
  });

  it("names the visitor's host on the internal hop", async () => {
    // auth-service resolves the tenant from the host it was called on; the
    // internal hop skips Traefik, so the host has to be said (F-066-r).
    fetchMock.mockResolvedValue(answer(200, { ok: true, data: { serves: true } }));
    await doorServes("acme.txnet.example", INTERNAL, true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${INTERNAL}/api/auth/door`);
    expect(init.headers[ProxyHeaders.forwardedHost]).toBe("acme.txnet.example");
  });

  it("does not restate the host when it goes out through the page's own origin", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, data: { serves: true } }));
    await doorServes("acme.txnet.example", "https://acme.txnet.example", false);

    expect(fetchMock.mock.calls[0][1].headers[ProxyHeaders.forwardedHost]).toBeUndefined();
  });

  it("asks once per host, not once per request", async () => {
    // `proxy.ts` runs on every non-static path, prefetches included.
    fetchMock.mockResolvedValue(answer(200, { ok: true, data: { serves: false } }));
    await doorServes("acme.txnet.example", INTERNAL, true);
    await doorServes("acme.txnet.example", INTERNAL, true);
    await doorServes("other.txnet.example", INTERNAL, true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
