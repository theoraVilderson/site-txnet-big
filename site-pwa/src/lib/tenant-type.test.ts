import { describe, expect, it } from "vitest";
import { isPlatformTenant, isPlatformUser, ownsPlatform } from "./tenant-type";

/**
 * FE-1-b, C-18: the panel asked "is this the platform" 21 times inline and
 * kept six local helpers, two of them named `isPlatformOwner` with different
 * meanings. Each question is one function here, and these are all of them.
 */
const PLATFORM = { type: "platform_owner", isOwner: false } as const;
const PLATFORM_OWNER = { type: "platform_owner", isOwner: true } as const;
const RESELLER = { type: "reseller", isOwner: true } as const;

describe("the tenant-type questions", () => {
  it("knows the platform's own tenant by its type alone", () => {
    expect(isPlatformTenant(PLATFORM.type)).toBe(true);
    expect(isPlatformTenant(RESELLER.type)).toBe(false);
    expect(isPlatformTenant(null)).toBe(false);
    expect(isPlatformTenant(undefined)).toBe(false);
  });

  it("tells the account that owns the platform from its users", () => {
    expect(ownsPlatform(PLATFORM_OWNER)).toBe(true);
    expect(ownsPlatform(PLATFORM)).toBe(false);
    // A reseller's owner owns a reseller, not the platform.
    expect(ownsPlatform(RESELLER)).toBe(false);
    expect(ownsPlatform(null)).toBe(false);
  });

  it("calls a platform user anyone on the platform but its owner account", () => {
    expect(isPlatformUser(PLATFORM)).toBe(true);
    expect(isPlatformUser(PLATFORM_OWNER)).toBe(false);
    expect(isPlatformUser(RESELLER)).toBe(false);
    expect(isPlatformUser(undefined)).toBe(false);
  });
});
