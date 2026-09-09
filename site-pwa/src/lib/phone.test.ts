import { describe, expect, it } from "vitest";
import {
  countryOptions,
  defaultPhoneCountry,
  flagOf,
  formatAsTyped,
  fromE164,
  looksComplete,
  readTyped,
  toE164,
} from "./phone";

/**
 * The panel's side of ADR-0018. Nothing here is Iran-shaped: the cases are a
 * table of countries, and the one Iranian expectation that remains is about
 * the *deployment language* choosing a default, which is the behaviour that
 * was asked for.
 */

const COUNTRIES = [
  { iso: "IR", national: "9121234567", e164: "+989121234567" },
  { iso: "US", national: "4155552671", e164: "+14155552671" },
  { iso: "DE", national: "15112345678", e164: "+4915112345678" },
  { iso: "GB", national: "7400123456", e164: "+447400123456" },
] as const;

describe("phone", () => {
  describe("the picker covers the world", () => {
    it("offers every country the library knows", () => {
      const options = countryOptions("en");
      expect(options.length).toBeGreaterThan(200);
      for (const { iso } of COUNTRIES) {
        expect(options.map((o) => o.iso)).toContain(iso);
      }
    });

    it("names each country in the language the panel is showing", () => {
      const en = countryOptions("en").find((c) => c.iso === "DE");
      const fa = countryOptions("fa").find((c) => c.iso === "DE");

      expect(en?.name).toBe("Germany");
      expect(fa?.name).not.toBe(en?.name);
      expect(en?.dialCode).toBe("+49");
    });

    it("renders a flag from the ISO code alone, with no asset to ship", () => {
      expect(flagOf("IR")).toBe("🇮🇷");
      expect(flagOf("de")).toBe("🇩🇪");
    });
  });

  describe("the default country follows the app language", () => {
    it.each([
      ["fa", "IR"],
      ["en", "US"],
      ["fa-IR", "IR"],
    ])("language %s opens the picker on %s", (lang, iso) => {
      expect(defaultPhoneCountry(lang)).toBe(iso);
    });

    it("falls back rather than crashing on a language nobody mapped", () => {
      expect(defaultPhoneCountry("sw")).toBe("US");
    });
  });

  describe("what the form submits is E.164, whatever was typed", () => {
    it.each(COUNTRIES)("$iso: $national -> $e164", ({ iso, national, e164 }) => {
      expect(toE164(national, iso)).toBe(e164);
      expect(looksComplete(national, iso)).toBe(true);
    });

    it.each(COUNTRIES)("$iso: round-trips back into the field", ({ iso, e164 }) => {
      const parsed = fromE164(e164, "US");
      expect(parsed.iso).toBe(iso);
      expect(toE164(parsed.national, parsed.iso)).toBe(e164);
    });

    it("keeps the user's leading zero out of the submitted number", () => {
      // A local types the trunk prefix out of habit; E.164 has no room for it.
      expect(toE164("09121234567", "IR")).toBe("+989121234567");
    });

    it("does not claim a half-typed number is complete", () => {
      expect(looksComplete("912", "IR")).toBe(false);
      expect(looksComplete("", "US")).toBe(false);
    });

    it("groups digits as the selected country writes them", () => {
      expect(formatAsTyped("4155552671", "US")).toBe("(415) 555-2671");
      expect(formatAsTyped("4155552671", "DE")).not.toBe("(415) 555-2671");
    });
  });

  describe("either spelling of a number is accepted", () => {
    it("leaves a national number with the country the picker is on", () => {
      const read = readTyped("09121234567", "IR");
      expect(read.iso).toBe("IR");
      expect(toE164(read.national, read.iso)).toBe("+989121234567");
    });

    it("moves the picker when the number is written internationally", () => {
      const read = readTyped("+4915112345678", "IR");
      expect(read.iso).toBe("DE");
      expect(toE164(read.national, read.iso)).toBe("+4915112345678");
    });

    it("takes the dial code out of the box once it is on the button", () => {
      // The field must never show `+49` next to a button that already says it.
      expect(readTyped("+4915112345678", "IR").national).not.toContain("+49");
    });

    it("reads the selected country's official IDD prefix too", () => {
      // `00` is how a person in Iran writes an international call.
      const read = readTyped("004915112345678", "IR");
      expect(read.iso).toBe("DE");
      expect(toE164(read.national, read.iso)).toBe("+4915112345678");
    });

    it("does not move the picker on a dial code it cannot yet resolve", () => {
      // `+1` is a dozen countries; the picker must not guess one mid-keystroke.
      expect(readTyped("+1", "IR").iso).toBe("IR");
    });
  });
});
