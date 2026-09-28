import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, holdsEveryPermission, holdsPermission } from "./permissions";

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
