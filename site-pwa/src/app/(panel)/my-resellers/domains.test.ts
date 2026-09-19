import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANEL_MY_RESELLERS, myResellerDomainsPath } from "@/lib/routes";
import {
  CHECK_LINE_KEYS,
  DOMAIN_PURPOSES,
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

  it("offers every purpose Prisma has, panel first", () => {
    const block = /enum TenantDomainPurpose \{([^}]*)\}/.exec(read("prisma/domains/tenant.prisma"));
    const purposes = block![1].split("\n").map((l) => l.trim()).filter((l) => /^[a-z_]+$/.test(l));
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

describe("the workspace path", () => {
  it("builds the path the app actually serves", () => {
    expect(myResellerDomainsPath("t-1")).toBe(`${PANEL_MY_RESELLERS}/t-1/domains`);
    expect(myResellerDomainsPath("a b/c")).toBe(`${PANEL_MY_RESELLERS}/a%20b%2Fc/domains`);
    expect(existsSync(join(__dirname, "[id]", "domains", "page.tsx"))).toBe(true);
  });
});
