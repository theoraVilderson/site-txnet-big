import { describe, expect, it } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { METER_UNITS } from "@/lib/billing/analytics";
import { UNIT_FORMATS, meterNamer, usageFormat } from "./_lib/usage";

/**
 * Usage per meter on the Overview (F-1001-o, ADR-0148). What goes wrong
 * without anyone seeing it:
 *
 *  - **a figure in the wrong unit.** Bytes, counts, seconds and tokens are
 *    each written their own way; a unit billing adds must fail this spec
 *    until it has a format, never fall back to bytes;
 *  - **a key where a name belongs.** A meter is named by its catalog text;
 *    one without a text yet reads as "usage", never as `catalog.meter.…`.
 */

const t = (_ns: string, key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const fmt = { full: (n: number) => String(n), compact: (n: number) => String(n), percent: (r: number) => `${r}` };

describe("usage formats", () => {
  it("has one for every unit billing answers", () => {
    expect(Object.keys(UNIT_FORMATS).sort()).toEqual([...METER_UNITS].sort());
  });

  it("writes bytes as a size, a count as a number, seconds as hours and tokens with their word", () => {
    const of = (unit: (typeof METER_UNITS)[number]) => usageFormat(unit, { lang: "en", t, fmt });
    expect(of("bytes")(1536)).toBe("1.5 KB");
    expect(of("count")(42)).toBe("42");
    expect(of("seconds")(5400)).toBe("1.5 hr");
    expect(of("tokens")(1200)).toBe(`${FrontendI18nKeys.common.analytics.units.tokens}:1200`);
  });
});

describe("meter names", () => {
  it("names a meter by its catalog text, and one without a text as usage", () => {
    const name = meterNamer({ products: [], panels: [], kinds: [], meters: [{ key: "vpn.traffic", unit: "bytes", nameKey: "catalog.meter.vpn.traffic.name" }] }, { "catalog.meter.vpn.traffic.name": "VPN traffic" }, t);
    expect(name("vpn.traffic")).toBe("VPN traffic");
    expect(name("ai.tokens")).toBe(FrontendI18nKeys.common.analytics.usage.unnamed);
  });
});
