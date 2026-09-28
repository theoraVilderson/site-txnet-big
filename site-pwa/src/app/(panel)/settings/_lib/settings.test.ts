import { describe, expect, it } from "vitest";
import type { Me } from "@/lib/auth-api";
import { canSetPlatformCurrency } from "./settings";

const me = (type: string, permissions: string[]) => ({ tenant: { type }, permissions }) as unknown as Me;

describe("canSetPlatformCurrency", () => {
  it("admits the platform's staff holding tenant.manage", () => {
    expect(canSetPlatformCurrency(me("platform_owner", ["tenant.manage"]))).toBe(true);
  });

  it("admits the platform's SuperAdmin, whose one key is *", () => {
    expect(canSetPlatformCurrency(me("platform_owner", ["*"]))).toBe(true);
  });

  it("refuses a reseller even with * or tenant.manage — it can grant itself either", () => {
    expect(canSetPlatformCurrency(me("reseller", ["*"]))).toBe(false);
    expect(canSetPlatformCurrency(me("reseller", ["tenant.manage"]))).toBe(false);
  });

  it("refuses platform staff without the key, and no session", () => {
    expect(canSetPlatformCurrency(me("platform_owner", ["coupon.manage"]))).toBe(false);
    expect(canSetPlatformCurrency(null)).toBe(false);
  });
});
