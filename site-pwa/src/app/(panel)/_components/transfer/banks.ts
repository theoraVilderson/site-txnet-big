import { IranBanks } from "@/generated/wire";

/**
 * Iranian bank cards for the drawn card (F-803-g, F-803-i): the issuer from
 * the BIN and its colour pair, read from `contracts/billing/iran-banks.json` —
 * the same table billing derives a card's `bankId` from, so the card the
 * seller sees while typing is the bank billing will store.
 */

export type BankId = keyof typeof IranBanks;
/** A card whose BIN is in no row: drawn in the brand's own colours, still accepted (billing `OTHER_BANK`). */
export const OTHER_BANK = "other";

/** A card number's issuer prefix (billing `BIN_LENGTH`). */
const BIN_LENGTH = 6;
/** An Iranian card number's length (billing `CARD_DIGITS`). */
export const CARD_LENGTH = 16;
/** The drawn number's grouping: 4-4-4-4, as printed on the card. */
const GROUP = 4;

const BANK_OF_BIN: ReadonlyMap<string, BankId> = new Map(
  (Object.keys(IranBanks) as BankId[]).flatMap((id) => IranBanks[id].bins.map((bin) => [bin, id] as const)),
);

/** The issuing bank of a card number, `other` when its BIN is in no row (or not yet typed). */
export function bankOfCard(digits: string): BankId | typeof OTHER_BANK {
  return digits.length < BIN_LENGTH ? OTHER_BANK : (BANK_OF_BIN.get(digits.slice(0, BIN_LENGTH)) ?? OTHER_BANK);
}

/** A bank's gradient pair, `null` for `other` (the card then takes the brand gradient). */
export function bankColors(bankId: string): readonly [string, string] | null {
  return bankId in IranBanks ? (IranBanks[bankId as BankId].colors as readonly [string, string]) : null;
}

/** Digits from any script, spaces and dashes dropped — billing's `foldDigits`, so the preview matches what is stored. */
export function foldDigits(raw: string): string {
  return raw
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s-]/g, "");
}

/** Luhn (ISO/IEC 7812): a typo in a card number, caught before the payer is shown it. Billing checks again. */
export function isLuhnValid(digits: string): boolean {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    const n = Number(d) * (i % 2 === 1 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return sum % 10 === 0;
}

/** The number as the card prints it, padded with dots where nothing is typed yet. */
export function cardGroups(digits: string): string[] {
  const padded = digits.slice(0, CARD_LENGTH).padEnd(CARD_LENGTH, "•");
  return Array.from({ length: CARD_LENGTH / GROUP }, (_, i) => padded.slice(i * GROUP, (i + 1) * GROUP));
}
