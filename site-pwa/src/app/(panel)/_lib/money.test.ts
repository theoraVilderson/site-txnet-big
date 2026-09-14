import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toEnglishDigits } from "@/util/helper";
import { amountInWords, currencyDecimals, formatMoney, type MoneyLocale } from "./money";

/**
 * F-093-b. What breaks silently here is an amount the user reads wrong: a
 * float that drops a digit, legacy's `toToman` dividing by ten a second time,
 * or words that disagree with the figure beside them. Every string comes from
 * the real `locales/frontend` content, and a key the speller asks for that a
 * language lacks throws instead of rendering as a raw dot path.
 */

const LOCALES = join(__dirname, "../../../../../locales/frontend/langs");

function flatten(prefix: string, value: unknown, out: Map<string, string>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, child] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, child, out);
  } else if (typeof value === "string") {
    out.set(prefix, value);
  }
}

/** `useLocale().t` over the shipped file, with `{{var}}` placeholders — but a miss throws. */
function localeFor(lang: string): MoneyLocale {
  const common = new Map<string, string>();
  flatten("", JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")), common);
  const t = (ns: string, key: string, vars?: Record<string, string | number>) => {
    const val = ns === "common" ? common.get(key) : undefined;
    if (val === undefined) throw new Error(`${lang}: missing ${ns}:${key}`);
    return val.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => String(vars?.[name] ?? ""));
  };
  return { lang, t };
}

const en = localeFor("en");
const fa = localeFor("fa");

/** Only the digits, in ASCII — independent of ICU's separators and bidi marks. */
const digitsOf = (s: string) => toEnglishDigits(s).replace(/[^\d]/g, "");

describe("currencyDecimals", () => {
  it.each([
    ["USD", 2],
    ["IRR", 0],
    ["IRT", 0], // not ISO 4217: Intl would say 2
  ])("%s -> %i", (code, digits) => {
    expect(currencyDecimals(code)).toBe(digits);
  });
});

describe("formatMoney", () => {
  it("never passes through a float — a 17-digit amount keeps every digit", () => {
    // As a number this is 9007199254740992: the last digit is gone.
    expect(formatMoney("9007199254740993.01", "USD", en)).toBe("$9,007,199,254,740,993.01");
  });

  it("renders the currency's own number of decimals", () => {
    expect(formatMoney("12.5", "USD", en)).toBe("$12.50");
    expect(digitsOf(formatMoney("150000", "IRR", en))).toBe("150000");
  });

  it("does not divide a Toman amount by ten — the amount is already in the currency it names", () => {
    expect(digitsOf(formatMoney("150000", "IRT", fa))).toBe("150000");
    expect(formatMoney("150000", "IRT", en)).toBe("150,000 Toman");
  });

  it("rounds half away from zero to the currency's decimals, on the decimal string", () => {
    expect(formatMoney("12.345", "USD", en)).toBe("$12.35");
    expect(formatMoney("-12.345", "USD", en)).toBe("-$12.35");
    expect(digitsOf(formatMoney("1500.5", "IRT", en))).toBe("1501");
  });

  it("writes Latin digits in every language, the currency word in the language's", () => {
    const persian = formatMoney("150000", "IRT", fa);
    expect(persian).not.toMatch(/[۰-۹]/);
    expect(persian).toContain("150,000");
    expect(persian).toContain("تومان");
    expect(formatMoney("150000", "IRT", en)).not.toMatch(/[۰-۹]/);
  });

  it("an explicit decimals setting wins over Intl's table", () => {
    expect(formatMoney("12.5", "USD", en, { decimals: 0 })).toBe("$13");
  });

  it("shows something recognisable for input it cannot read, rather than throwing", () => {
    expect(formatMoney("abc", "USD", en)).toBe("abc");
    expect(() => formatMoney("12", "not-a-code", en)).not.toThrow();
  });
});

describe("amountInWords", () => {
  it.each([
    [0, "zero Toman"],
    [7, "seven Toman"],
    [15, "fifteen Toman"],
    [40, "forty Toman"],
    [42, "forty-two Toman"],
    [100, "one hundred Toman"],
    [110, "one hundred ten Toman"],
    [1000, "one thousand Toman"],
    [1005, "one thousand five Toman"],
    [1234567, "one million two hundred thirty-four thousand five hundred sixty-seven Toman"],
    [2000000000, "two billion Toman"],
  ])("en: %i", (amount, words) => {
    expect(amountInWords(amount, "IRT", en)).toBe(words);
  });

  // The legacy numberToPersianWords output for the same numbers, less its
  // hard-coded " تومان" suffix — the currency name is now the locale's.
  it.each([
    [0, "صفر"],
    [20, "بیست"],
    [110, "صد و ده"],
    [1000, "یک هزار"],
    [1005, "یک هزار و پنج"],
    [250000, "دویست و پنجاه هزار"],
    [1234567, "یک میلیون و دویست و سی و چهار هزار و پانصد و شصت و هفت"],
  ])("fa: %i", (amount, words) => {
    expect(amountInWords(amount, "IRT", fa)).toBe(`${words} تومان`);
  });

  it("spells the same rounded amount the figure shows", () => {
    expect(formatMoney("12.345", "USD", en)).toBe("$12.35");
    expect(amountInWords("12.345", "USD", en)).toBe("twelve US dollars and thirty-five cents");
    expect(amountInWords("1.00", "USD", en)).toBe("one US dollar");
    expect(amountInWords("1500.5", "IRT", fa)).toBe("یک هزار و پانصد و یک تومان");
  });

  it("spells a negative amount", () => {
    expect(amountInWords("-5", "IRT", en)).toBe("minus five Toman");
  });

  it("keeps an amount past a trillion exact, and gives up past the largest scale", () => {
    expect(amountInWords("999999999999999", "IRR", en)).toMatch(/^nine hundred ninety-nine trillion .* rials$/);
    expect(amountInWords("1000000000000000", "IRR", en)).toBeNull();
  });

  it("answers null — not a guess — for a currency or input it has no words for", () => {
    expect(amountInWords("10", "EUR", en)).toBeNull();
    expect(amountInWords("abc", "IRT", en)).toBeNull();
  });
});
