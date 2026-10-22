import { describe, expect, it } from "vitest";
import type { Me } from "@/lib/auth-api";
import { canPinRates, canSetPlatformCurrency, canSetPlatformSelfMove, settingsTabs } from "./settings";

const me = (type: string, permissions: string[]) => ({ tenant: { type }, permissions }) as unknown as Me;

describe("canSetPlatformCurrency", () => {
  it("admits the platform's staff holding settings.manage (AC-1-e)", () => {
    expect(canSetPlatformCurrency(me("platform_owner", ["settings.manage"]))).toBe(true);
  });

  it("admits the platform's SuperAdmin, whose one key is *", () => {
    expect(canSetPlatformCurrency(me("platform_owner", ["*"]))).toBe(true);
  });

  it("refuses a reseller even with * or settings.manage — its own settings are not the platform's", () => {
    expect(canSetPlatformCurrency(me("reseller", ["*"]))).toBe(false);
    expect(canSetPlatformCurrency(me("reseller", ["settings.manage"]))).toBe(false);
  });

  it("refuses platform staff without the key, and no session", () => {
    expect(canSetPlatformCurrency(me("platform_owner", ["coupon.manage"]))).toBe(false);
    expect(canSetPlatformCurrency(null)).toBe(false);
  });
});

describe("canPinRates", () => {
  it("admits currency.pin or * on either tenant type — the service scopes the pin", () => {
    expect(canPinRates(me("platform_owner", ["currency.pin"]))).toBe(true);
    expect(canPinRates(me("reseller", ["currency.pin"]))).toBe(true);
    expect(canPinRates(me("platform_owner", ["*"]))).toBe(true);
  });

  it("refuses without the key, and no session", () => {
    expect(canPinRates(me("platform_owner", ["settings.manage"]))).toBe(false);
    expect(canPinRates(null)).toBe(false);
  });
});

describe("canSetPlatformSelfMove (F-410-h)", () => {
  it("admits the platform's staff holding catalog.manage, or *, and draws the workspace for them", () => {
    expect(canSetPlatformSelfMove(me("platform_owner", ["catalog.manage"]))).toBe(true);
    expect(canSetPlatformSelfMove(me("platform_owner", ["*"]))).toBe(true);
    expect(settingsTabs(me("platform_owner", ["catalog.manage"])).at(-1)?.value).toBe("workspace");
  });

  it("refuses a reseller — its own setting is on its workspace — staff without the key, and no session", () => {
    expect(canSetPlatformSelfMove(me("reseller", ["*"]))).toBe(false);
    expect(canSetPlatformSelfMove(me("platform_owner", ["settings.manage"]))).toBe(false);
    expect(canSetPlatformSelfMove(null)).toBe(false);
  });
});
