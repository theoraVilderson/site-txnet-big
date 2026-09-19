// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDoorCache, doorServes } from "./door";

/**
 * The panel's half of the door rules (F-066-x): `site-pwa` renders nothing on
 * a host tenant-service says serves no panel — a `subscription` / `assets`
 * domain, or a reseller's platform subdomain. Asked at
 * `GET /api/public/tenant/serves-panel` (F-018-ak, ADR-0065).
 *
 * Every doubt ends in rendering: an unregistered host (the neutral 404,
 * F-066-u's own call), an unreachable service, a body that does not parse.
 * The server-side guards still refuse every API call there, so the worst case
 * is an empty shell, never data.
 */
describe("doorServes", () => {
  let server: http.Server;
  let origin: string;
  const seen: { host?: string; path?: string; cookie?: string }[] = [];
  let reply: (res: http.ServerResponse) => void;

  const verdict = (serves: unknown) => (res: http.ServerResponse) =>
    res.end(JSON.stringify({ ok: true, data: { serves } }));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url, cookie: req.headers.cookie });
      reply(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
    clearDoorCache();
  });

  it("is closed when tenant-service says so", async () => {
    reply = verdict(false);
    await expect(doorServes("acme.txnet.example", origin)).resolves.toBe(false);
  });

  it("is open when tenant-service says so", async () => {
    reply = verdict(true);
    await expect(doorServes("shop.acme.com", origin)).resolves.toBe(true);
  });

  it.each([
    ["an unregistered host (the neutral 404)", (res: http.ServerResponse) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    }],
    ["an unparseable body", (res: http.ServerResponse) => res.end("<html>")],
    ["an envelope with no verdict", (res: http.ServerResponse) => res.end(JSON.stringify({ ok: true, data: {} }))],
  ])("renders on %s", async (_label, respond) => {
    reply = respond;
    await expect(doorServes("x.example", origin)).resolves.toBe(true);
  });

  it("renders when tenant-service cannot be reached", async () => {
    await expect(doorServes("x.example", "http://127.0.0.1:1")).resolves.toBe(true);
  });

  it("asks serves-panel with the visitor's host as Host, and no cookie", async () => {
    // tenant-service names the tenant from `Host` (ADR-0065); the internal hop
    // skips Traefik, so the host has to be said.
    reply = verdict(true);
    await doorServes("acme.txnet.example", origin);
    expect(seen).toEqual([
      { host: "acme.txnet.example", path: "/api/public/tenant/serves-panel", cookie: undefined },
    ]);
  });

  it("asks once per host, not once per request", async () => {
    // `proxy.ts` runs on every non-static path, prefetches included.
    reply = verdict(false);
    await doorServes("acme.txnet.example", origin);
    await doorServes("acme.txnet.example", origin);
    await doorServes("other.txnet.example", origin);
    expect(seen.map((s) => s.host)).toEqual(["acme.txnet.example", "other.txnet.example"]);
  });
});
