import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, RESELLER_KEYS, holdsAnyResellerKey, holdsEveryPermission, holdsPermission } from "./permissions";

describe("holdsPermission", () => {
  it("is true for the key itself, and for * (SuperAdmin) whatever the key", () => {
    expect(holdsPermission(["tenant.manage"], "tenant.manage")).toBe(true);
    expect(holdsPermission([ALL_PERMISSIONS], "tenant.manage")).toBe(true);
    expect(holdsPermission(["*"], "a.key.no.page.knows.yet")).toBe(true);
  });

  it("is false for another key, a prefix pattern, an empty or missing list", () => {
    expect(holdsPermission(["coupon.manage"], "tenant.manage")).toBe(false);
    expect(holdsPermission(["tenant.*"], "tenant.manage")).toBe(false);
    expect(holdsPermission([], "tenant.manage")).toBe(false);
    expect(holdsPermission(undefined, "tenant.manage")).toBe(false);
    expect(holdsPermission(null, "tenant.manage")).toBe(false);
  });
});

describe("holdsEveryPermission", () => {
  it("needs every key, or *; an empty requirement is met", () => {
    expect(holdsEveryPermission(["a.x", "b.y"], ["a.x", "b.y"])).toBe(true);
    expect(holdsEveryPermission(["a.x"], ["a.x", "b.y"])).toBe(false);
    expect(holdsEveryPermission(["*"], ["a.x", "b.y"])).toBe(true);
    expect(holdsEveryPermission([], [])).toBe(true);
    expect(holdsEveryPermission(undefined, ["a.x"])).toBe(false);
  });
});

describe("RESELLER_KEYS (AC-1-e2)", () => {
  it("is the API's list: shared-core's reseller-keys.ts, key for key", () => {
    const source = readFileSync(join(__dirname, "../../../txnet-backend/shared-core/src/lib/tenant/reseller-keys.ts"), "utf8");
    const body = source.slice(source.indexOf("RESELLER_KEYS = ["), source.indexOf("] as const"));
    const api = [...body.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(api.length).toBeGreaterThan(0);
    expect([...RESELLER_KEYS]).toEqual(api);
  });

  it("is held by any one key or `*`, never by a platform key", () => {
    expect(holdsAnyResellerKey(["domain.manage"])).toBe(true);
    expect(holdsAnyResellerKey([ALL_PERMISSIONS])).toBe(true);
    expect(holdsAnyResellerKey(["platform.tenant.manage", "self.read"])).toBe(false);
    expect(holdsAnyResellerKey(undefined)).toBe(false);
  });
});
