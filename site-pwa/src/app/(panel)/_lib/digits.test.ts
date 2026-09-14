import { describe, expect, it } from "vitest";
import { LATIN_DIGITS, numberLocale } from "./digits";
import { formatInstant } from "./datetime";
import { formatMoney } from "./money";

/**
 * Numbers are written in Latin digits in every language (user decision,
 * 2026-09-13). The language still decides everything else — the Jalali
 * calendar for `fa`, the currency's word, the direction — only the digit glyphs
 * are fixed, so an amount copied from a `fa` screen pastes the same as `en`.
 */
const t = (_ns: string, key: string, params?: Record<string, string | number>) => (params?.amount ? `${params.amount} ${key}` : key);
const PERSIAN = /[۰-۹٠-٩]/;

describe("Latin digits in every language", () => {
  it("tags the language with the latn numbering system", () => {
    expect(numberLocale("fa")).toBe("fa-u-nu-latn");
    expect(numberLocale("en")).toBe("en-u-nu-latn");
  });

  it("formats money in Latin digits for fa", () => {
    const out = formatMoney("150000.5", "USD", { lang: "fa", t });
    expect(out).not.toMatch(PERSIAN);
    expect(out).toContain("150,000.50");
  });

  it("keeps the Jalali calendar but writes it in Latin digits", () => {
    const out = formatInstant("2026-09-12T08:30:00.000Z", "fa", { withTime: false });
    expect(out).toBe("1405/06/21");
  });

  it("hands the date picker ten Latin digits", () => {
    expect(LATIN_DIGITS).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });
});
