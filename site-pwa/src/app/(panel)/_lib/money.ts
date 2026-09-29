import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { numberLocale } from "./digits";
import type { Translate } from "@/util/helper";

/**
 * Money on a panel screen (F-093-b): one figure and, where a form asks for it,
 * the same figure in words.
 *
 * The amount is already in the currency it names. Converting from the base
 * currency is the `currency` unit's job and happens before this (ADR-0019);
 * legacy's `toToman` divided by ten here, and a second division is exactly the
 * mistake that looks right on a screen. The amount stays a decimal string from
 * API to glyph — Prisma's `Decimal` arrives as one, and `Intl.NumberFormat`
 * formats a string without turning it into a float first.
 */

/*
 * There is no default currency here (F-116-h3, ADR-0098 part 3). Every route
 * names the currency of the amounts it answers — a list row its **own**, which
 * may not be the tenant's now — and a screen passes that code to
 * `formatMoney`. A USD row written before a switch to IRR still reads as
 * dollars; a constant here is how it read as whatever the constant said.
 */

/** `useLocale()` narrowed to what this module reads. */
export interface MoneyLocale {
  lang: string;
  t: Translate;
}

export interface MoneyOptions {
  /** The currency row's `decimalPlaces`, when the caller has it. Wins over Intl's table. */
  decimals?: number;
}

const M = FrontendI18nKeys.common.money;
const W = M.words;

/**
 * Display currencies that are not ISO 4217. Intl would accept the code, give it
 * two decimals and print the code itself, so each one is formatted through its
 * locale template instead.
 */
const NON_ISO: Record<string, { decimals: number; format: string }> = {
  IRT: { decimals: 0, format: M.currency.IRT.format },
};

/** Currency names for words, per plural category. A code missing here has no words. */
const CURRENCY_WORDS: Record<
  string,
  { major: Record<"one" | "other", string>; minor?: Record<"one" | "other", string> }
> = {
  IRT: { major: M.currency.IRT.major },
  IRR: { major: M.currency.IRR.major },
  USD: { major: M.currency.USD.major, minor: M.currency.USD.minor },
};

const ONES = [
  "",
  W.ones.one, W.ones.two, W.ones.three, W.ones.four, W.ones.five,
  W.ones.six, W.ones.seven, W.ones.eight, W.ones.nine,
];
const TEENS = [
  W.teens.ten, W.teens.eleven, W.teens.twelve, W.teens.thirteen, W.teens.fourteen,
  W.teens.fifteen, W.teens.sixteen, W.teens.seventeen, W.teens.eighteen, W.teens.nineteen,
];
const TENS = [
  "", "",
  W.tens.twenty, W.tens.thirty, W.tens.forty, W.tens.fifty,
  W.tens.sixty, W.tens.seventy, W.tens.eighty, W.tens.ninety,
];
const HUNDREDS = [
  "",
  W.hundreds.one, W.hundreds.two, W.hundreds.three, W.hundreds.four, W.hundreds.five,
  W.hundreds.six, W.hundreds.seven, W.hundreds.eight, W.hundreds.nine,
];
/** `BigInt(n)` rather than `5n`: the panel compiles to ES2017, which has no bigint literals. */
const ZERO = BigInt(0);
const FIVE = BigInt(5);
const TEN = BigInt(10);
const THOUSAND = BigInt(1000);

const SCALES = [W.scales.thousand, W.scales.million, W.scales.billion, W.scales.trillion];

/** The number of decimals a currency is shown with. */
export function currencyDecimals(currency: string, options: MoneyOptions = {}): number {
  if (options.decimals !== undefined) return options.decimals;
  const nonIso = NON_ISO[currency];
  if (nonIso) return nonIso.decimals;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

interface Rounded {
  negative: boolean;
  /** The absolute amount in minor units: 12.35 with 2 decimals is 1235n. */
  minorUnits: bigint;
  decimals: number;
}

/** Round a decimal string half away from zero, without leaving integer arithmetic. */
function roundDecimal(amount: string | number, decimals: number): Rounded | null {
  const match = /^\s*(-)?(\d+)(?:\.(\d*))?\s*$/.exec(String(amount));
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const kept = fraction.padEnd(decimals + 1, "0").slice(0, decimals + 1);
  const minorUnits = (BigInt(whole + kept) + FIVE) / TEN;
  return { negative: sign === "-" && minorUnits > ZERO, minorUnits, decimals };
}

/** The rounded amount back as an exact decimal string Intl can take. */
function toDecimalString({ negative, minorUnits, decimals }: Rounded): string {
  const digits = minorUnits.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${whole}${decimals ? `.${fraction}` : ""}`;
}

/**
 * `150000`, `"IRT"`, fa -> `150,000 تومان`. Latin digits in every language
 * (`digits.ts`); the currency word follows the language; unreadable input comes back as it was rather than as `NaN`.
 */
export function formatMoney(
  amount: string | number,
  currency: string,
  { lang, t }: MoneyLocale,
  options: MoneyOptions = {},
): string {
  const decimals = currencyDecimals(currency, options);
  const rounded = roundDecimal(amount, decimals);
  if (!rounded) return String(amount);
  // Intl's types predate exact decimal strings; the runtime has taken them since Node 19.
  const exact = toDecimalString(rounded) as unknown as number;
  const digits = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };

  const nonIso = NON_ISO[currency];
  if (!nonIso) {
    try {
      return new Intl.NumberFormat(numberLocale(lang), { style: "currency", currency, ...digits }).format(exact);
    } catch {
      // Not a code Intl can read: the figure, then the code as given.
      return `${new Intl.NumberFormat(numberLocale(lang), digits).format(exact)} ${currency}`;
    }
  }
  return t("common", nonIso.format, { amount: new Intl.NumberFormat(numberLocale(lang), digits).format(exact) });
}

function spellBelowThousand(n: number, t: Translate): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  let restWords = "";
  if (rest >= 20) {
    const tens = t("common", TENS[Math.floor(rest / 10)]);
    restWords = rest % 10
      ? t("common", W.tensAndOnes, { tens, ones: t("common", ONES[rest % 10]) })
      : tens;
  } else if (rest >= 10) {
    restWords = t("common", TEENS[rest - 10]);
  } else if (rest > 0) {
    restWords = t("common", ONES[rest]);
  }
  if (!hundreds) return restWords;
  const hundredsWords = t("common", HUNDREDS[hundreds]);
  return restWords
    ? t("common", W.hundredsAndRest, { hundreds: hundredsWords, rest: restWords })
    : hundredsWords;
}

/** A whole number in words, or null past the largest scale the locale names. */
function spellInteger(value: bigint, t: Translate): string | null {
  if (value === ZERO) return t("common", W.zero);
  const groups: number[] = [];
  for (let rest = value; rest > ZERO; rest /= THOUSAND) groups.push(Number(rest % THOUSAND));
  if (groups.length > SCALES.length + 1) return null;

  let words = "";
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    let group = spellBelowThousand(groups[i], t);
    if (i > 0) group = t("common", W.scaled, { count: group, scale: t("common", SCALES[i - 1]) });
    words = words ? t("common", W.groups, { high: words, low: group }) : group;
  }
  return words;
}

/**
 * The amount `formatMoney` shows, in words: `1234`, `"IRT"`, en -> `one
 * thousand two hundred thirty-four Toman`. Null when there is nothing honest
 * to say — a currency with no names in the locale, unreadable input, or a
 * number past the largest scale. A caller hides the line on null.
 */
export function amountInWords(
  amount: string | number,
  currency: string,
  { lang, t }: MoneyLocale,
  options: MoneyOptions = {},
): string | null {
  const names = CURRENCY_WORDS[currency];
  if (!names) return null;
  const rounded = roundDecimal(amount, currencyDecimals(currency, options));
  if (!rounded) return null;

  const scale = TEN ** BigInt(rounded.decimals);
  const major = rounded.minorUnits / scale;
  const minor = rounded.minorUnits % scale;
  const plurals = new Intl.PluralRules(lang);
  const category = (n: bigint) => (plurals.select(Number(n)) === "one" ? "one" : "other");

  const words = spellInteger(major, t);
  if (words === null) return null;
  const currencyName = t("common", names.major[category(major)]);

  let phrase: string;
  if (minor > ZERO) {
    if (!names.minor) return null;
    phrase = t("common", W.amountWithMinor, {
      words,
      currency: currencyName,
      minorWords: spellInteger(minor, t) ?? "",
      minor: t("common", names.minor[category(minor)]),
    });
  } else {
    phrase = t("common", W.amount, { words, currency: currencyName });
  }
  return rounded.negative ? t("common", W.negative, { words: phrase }) : phrase;
}

/**
 * A rial amount spelled in toman — how a person says it, and what they check
 * against the bank's page: `"2500000"`, fa -> `دویست و پنجاه هزار تومان`. Ten
 * rial to the toman is a unit. An odd rial rounds to the nearest toman: "صد
 * هزار تومان و دو ریال" confused people (user, 2026-09-29), and the exact
 * figure is printed beside the words anyway. Null for anything but a whole
 * rial amount.
 */
export function rialInTomanWords(rial: string, locale: MoneyLocale): string | null {
  const whole = rial.replace(/\.0*$/, "");
  if (!/^\d+$/.test(whole)) return null;
  const padded = whole.padStart(2, "0");
  return amountInWords(`${padded.slice(0, -1)}.${padded.slice(-1)}`, "IRT", locale);
}

/**
 * Whether billing's decimal string is more than nothing — a held figure worth a
 * line (F-118-j). Read off the string; a float would call `"0.001"` zero.
 */
export function isNonZero(amount: string | null): amount is string {
  return amount !== null && !/^0*(\.0*)?$/.test(amount.trim());
}
