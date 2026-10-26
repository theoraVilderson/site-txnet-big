import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RealtimeEvents } from "@/generated/wire";
import { PANEL_MY_RESELLERS, myResellerDomainsPath } from "@/lib/routes";
import {
  CHECK_LINE_KEYS,
  DOMAIN_LIVE_EVENTS,
  DOMAIN_PATHS,
  apexRefused,
  domainRecords,
  edgeLabelKey,
  ownEdgeSettings,
  DOMAIN_PURPOSES,
  EDGE_STATUS_KEYS,
  domainLiveChannels,
  dnsName,
  isApex,
  isLive,
  DOMAIN_REFUSAL_KEYS,
  DOMAIN_STATUS_KEYS,
  canRequestCheck,
  domainHost,
  domainRefusalKey,
  isRoutable,
} from "./_lib/domains";

/**
 * A reseller's domains, `/my-resellers/[id]/domains` (F-066-w2, ADR-0064 (4)).
 * What breaks with nothing red anywhere:
 *  - **a refusal, a status or a check line with no sentence.** Each is read
 *    out of tenant-service's (and shared-core's) own closed union, so a value
 *    added there fails here instead of reaching an owner as a blank line;
 *  - **a host the `.strict()` schema refuses** sent anyway — a port, an IP, a
 *    single label — or a pasted `https://…/` sent as typed;
 *  - **"check now" offered where the route ignores it.** Only `pending` and
 *    `failed` move to `verifying`; any other status comes back unchanged;
 *  - **a link to a path Next does not serve.**
 */
const REPO = join(__dirname, "../../../../..");
const read = (path: string) => readFileSync(join(REPO, "txnet-backend", path), "utf8");

function unionOf(file: string, name: string): string[] {
  const union = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(read(file));
  if (!union) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const SERVICE = "tenant-service/src/app/domains/tenant-domain.service.ts";

describe("what the domain routes can refuse", () => {
  it("has a sentence for every reason, the admission's included", () => {
    const reasons = [
      ...unionOf("shared-core/src/lib/tenant/reseller-access.ts", "ResellerAccessRejection"),
      ...unionOf(SERVICE, "DomainRejection"),
    ];
    expect(Object.keys(DOMAIN_REFUSAL_KEYS).sort()).toEqual([...new Set(reasons)].sort());
  });

  it("names the refusal it knows and nothing else", () => {
    expect(domainRefusalKey({ reason: "domain_taken" })).toBe(DOMAIN_REFUSAL_KEYS.domain_taken);
    expect(domainRefusalKey({ reason: "reseller_suspended" })).toBe(DOMAIN_REFUSAL_KEYS.reseller_suspended);
    expect(domainRefusalKey({ reason: "slug_taken" })).toBeNull();
    expect(domainRefusalKey(new Error("offline"))).toBeNull();
  });
});

describe("what a domain can be", () => {
  it("labels every status the view answers", () => {
    expect(Object.keys(DOMAIN_STATUS_KEYS).sort()).toEqual(unionOf(SERVICE, "DomainStatus").sort());
  });

  it("labels every line a check stores", () => {
    const lines = unionOf("tenant-service/src/app/domains/domain-check.ts", "CheckName");
    expect(Object.keys(CHECK_LINE_KEYS).sort()).toEqual(lines.sort());
  });

  it("labels every edge step Prisma has (EDGE-1-e)", () => {
    const block = /enum TenantDomainEdgeStatus \{([^}]*)\}/.exec(read("prisma/domains/tenant.prisma"));
    const steps = block![1].split("\n").map((l) => l.trim()).filter((l) => /^[a-z_]+$/.test(l));
    expect(Object.keys(EDGE_STATUS_KEYS).sort()).toEqual(steps.sort());
  });

  it("is live only verified with its certificate issued (ADR-0129 (3)), or verified on its own edge (NIN-1-e1)", () => {
    expect(isLive("verified", "issued", "platform_cdn")).toBe(true);
    expect(isLive("revalidating", "issued", "platform_cdn")).toBe(true);
    expect(isLive("verified", "issuing", "platform_cdn")).toBe(false);
    expect(isLive("pending", "issued", "platform_cdn")).toBe(false);
    expect(isLive("verified", "none", "own_edge")).toBe(true);
    expect(isLive("verifying", "none", "own_edge")).toBe(false);
  });

  it("offers every purpose Prisma has, panel first", () => {
    const block = /enum TenantDomainPurpose \{([^}]*)\}/.exec(read("prisma/domains/tenant.prisma"));
    // `api` is the platform's gateway host (seeded), never a domain a reseller adds (3a474da8).
    const purposes = block![1].split("\n").map((l) => l.trim()).filter((l) => /^[a-z_]+$/.test(l) && l !== "api");
    expect([...DOMAIN_PURPOSES].sort()).toEqual(purposes.sort());
    expect(DOMAIN_PURPOSES[0]).toBe("panel");
  });

  it("routes while verified or revalidating, never before", () => {
    expect(isRoutable("verified")).toBe(true);
    expect(isRoutable("revalidating")).toBe(true);
    expect(isRoutable("verifying")).toBe(false);
    expect(isRoutable("pending")).toBe(false);
  });
});

describe("the path a domain takes (NIN-1-e3, ADR-0165 point 7)", () => {
  const ownOffer = { path: "own_edge" as const, target: "ali.edge.barghgho.ir", port: 8443, edges: ["arvan"] };

  it("offers every path Prisma has, ours first", () => {
    const block = /enum TenantDomainPath \{([^}]*)\}/.exec(read("prisma/domains/tenant.prisma"));
    const paths = block![1].split("\n").map((l) => l.trim()).filter((l) => /^[a-z_]+$/.test(l));
    expect([...DOMAIN_PATHS].sort()).toEqual(paths.sort());
    expect(DOMAIN_PATHS[0]).toBe("platform_cdn");
  });

  it("names every edge the domestic door admits, so adding one to the list fails here until it has a name", () => {
    const edges = JSON.parse(readFileSync(join(REPO, "scripts/edge/edges.json"), "utf8")).edges as { name: string; door: string }[];
    for (const e of edges.filter((x) => x.door === "domestic")) expect(edgeLabelKey(e.name), e.name).not.toBeNull();
    expect(edgeLabelKey("nobody")).toBeNull();
  });

  it("tells its own edge what to set: the target, port 8443, HTTPS, the visitor's host, the cloud and WebSockets on", () => {
    const rows = ownEdgeSettings(ownOffer, "shop.ali.ir");
    expect(rows.map((r) => r.id)).toEqual(["origin", "port", "protocol", "host", "cloud", "websocket"]);
    expect(rows.find((r) => r.id === "origin")).toMatchObject({ value: "ali.edge.barghgho.ir", copy: true });
    expect(rows.find((r) => r.id === "port")).toMatchObject({ value: "8443" });
    expect(rows.find((r) => r.id === "host")).toMatchObject({ value: "shop.ali.ir" });
  });

  it("asks for a CNAME at the DNS only on our Cloudflare: on its own edge the origin is set in the edge", () => {
    const domain = {
      domainValue: "shop.ali.ir",
      record: { type: "TXT" as const, name: "_domain-verification.shop.ali.ir", value: "t" },
      cnameTarget: "ali.edge.txnet.cyou",
      edge: { status: "none" as const, record: null, lastError: null },
    };
    expect(domainRecords({ ...domain, path: "platform_cdn" }).map((r) => r.type)).toEqual(["TXT", "CNAME"]);
    expect(domainRecords({ ...domain, path: "own_edge" }).map((r) => r.type)).toEqual(["TXT"]);
  });

  it("refuses an apex only on our Cloudflare, whose Custom Hostname cannot be one", () => {
    expect(apexRefused("ali.ir", "platform_cdn")).toBe(true);
    expect(apexRefused("ali.ir", "own_edge")).toBe(false);
    expect(apexRefused("shop.ali.ir", "platform_cdn")).toBe(false);
  });
});

describe("check now", () => {
  it("is offered only where the route moves the domain", () => {
    expect(canRequestCheck("pending")).toBe(true);
    expect(canRequestCheck("failed")).toBe(true);
    expect(canRequestCheck("verifying")).toBe(false);
    expect(canRequestCheck("verified")).toBe(false);
    expect(canRequestCheck("revalidating")).toBe(false);
  });
});

describe("the host an owner types", () => {
  it("is sent the way the schema takes it", () => {
    expect(domainHost("panel.example.com")).toBe("panel.example.com");
    expect(domainHost("  Panel.Example.COM. ")).toBe("panel.example.com");
    expect(domainHost("https://panel.example.com/")).toBe("panel.example.com");
    expect(domainHost("http://shop.my-vpn.ir/login")).toBe("shop.my-vpn.ir");
  });

  it("is refused before the call when the schema would refuse it", () => {
    expect(domainHost("panel.example.com:8443")).toBeNull();
    expect(domainHost("10.0.0.1")).toBeNull();
    expect(domainHost("localhost")).toBeNull();
    expect(domainHost("-bad.example.com")).toBeNull();
    expect(domainHost("")).toBeNull();
  });
});

describe("an apex domain (ADR-0129 Consequences)", () => {
  it("is refused: below Enterprise a Custom Hostname must be a subdomain", () => {
    expect(isApex("example.com")).toBe(true);
    expect(isApex("my-vpn.ir")).toBe(true);
    expect(isApex("panel.example.com")).toBe(false);
    expect(isApex("shop.my-vpn.ir")).toBe(false);
  });
});

describe("the page re-reads live (RT-1-e)", () => {
  it("on tenant.domain.changed and nothing else", () => {
    expect([...DOMAIN_LIVE_EVENTS]).toEqual([RealtimeEvents.tenantDomainChanged]);
  });

  it("hears the owner's own channel, and the platform's when the session may", () => {
    const me = (permissions: string[]) => ({ tenant: { id: "p-1" }, permissions });
    expect(domainLiveChannels("u-1", me([]))).toEqual(["user:u-1", null]);
    expect(domainLiveChannels("u-1", me(["realtime.tenant.read"]))).toEqual(["user:u-1", "tenant:p-1"]);
    expect(domainLiveChannels(null, null)).toEqual([null, null]);
  });
});

describe("the workspace path", () => {
  it("builds the path the app actually serves", () => {
    expect(myResellerDomainsPath("t-1")).toBe(`${PANEL_MY_RESELLERS}/t-1/domains`);
    expect(myResellerDomainsPath("a b/c")).toBe(`${PANEL_MY_RESELLERS}/a%20b%2Fc/domains`);
    expect(existsSync(join(__dirname, "[id]", "domains", "page.tsx"))).toBe(true);
  });
});

describe("a record's name as the DNS panel takes it (EDGE-1-o, D-72)", () => {
  it("names a record inside the domain's own zone, and keeps the full name beside it", () => {
    expect(dnsName("_domain-verification.panel.barghgho.ir")).toEqual({
      short: "_domain-verification.panel",
      zone: "barghgho.ir",
      full: "_domain-verification.panel.barghgho.ir",
    });
    expect(dnsName("panel.barghgho.ir")).toMatchObject({ short: "panel", zone: "barghgho.ir" });
  });

  it("writes the zone itself as @", () => {
    expect(dnsName("barghgho.ir")).toMatchObject({ short: "@", zone: "barghgho.ir" });
    expect(dnsName("_domain-verification.barghgho.ir")).toMatchObject({ short: "_domain-verification" });
  });

  it("finds the zone under a suffix of two labels", () => {
    expect(dnsName("_domain-verification.panel.shop.co.ir")).toMatchObject({ short: "_domain-verification.panel", zone: "shop.co.ir" });
    expect(dnsName("_cf-custom-hostname.vpn.example.co.uk")).toMatchObject({ short: "_cf-custom-hostname.vpn", zone: "example.co.uk" });
  });

  it("tells an apex apart under a suffix of two labels", () => {
    expect(isApex("shop.co.ir")).toBe(true);
    expect(isApex("panel.shop.co.ir")).toBe(false);
    expect(isApex("barghgho.ir")).toBe(true);
  });
});

