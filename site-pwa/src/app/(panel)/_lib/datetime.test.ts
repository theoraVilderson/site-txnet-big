import { describe, expect, it } from "vitest";
import { dayIn, platformDayStart, platformToday } from "./datetime";

/**
 * FE-1-c: the platform's day was worked out in catalog-form, coupon-form and
 * discount-rules, each with its own `+03:30`, and support's day key was a
 * fourth `en-CA` formatter. One home now, so the next zone change is one edit.
 */
describe("a day on a wall clock", () => {
  it("is the platform's day, not UTC's, just after Tehran's midnight", () => {
    // 22:00 UTC is 01:30 the next day in Tehran.
    expect(platformToday(Date.parse("2026-09-25T22:00:00Z"))).toBe("2026-09-26");
    expect(platformToday(Date.parse("2026-09-25T20:00:00Z"))).toBe("2026-09-25");
  });

  it("starts a picked platform day at its first instant in Tehran", () => {
    expect(platformDayStart("2026-10-01")).toBe("2026-10-01T00:00:00+03:30");
    expect(platformToday(Date.parse(platformDayStart("2026-10-01")))).toBe("2026-10-01");
  });

  it("reads an instant on the zone asked, and on the browser's when that zone is unreadable", () => {
    expect(dayIn("2026-09-25T22:00:00Z", "Asia/Tehran")).toBe("2026-09-26");
    expect(dayIn("2026-09-25T22:00:00Z", "UTC")).toBe("2026-09-25");
    expect(dayIn("2026-09-25T12:00:00Z", "Not/AZone")).toMatch(/^2026-09-2[56]$/);
  });
});
