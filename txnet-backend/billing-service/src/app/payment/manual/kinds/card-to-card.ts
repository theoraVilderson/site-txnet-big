import { foldToOneSpelling } from '@txnet-backend/shared-core';

import { type FieldCheck, foldDigits, type ManualMethod, PAID_AT, RECEIPT_IMAGE, textCheck } from '../manual-method';
import { BANK_IDS, bankOfCard } from './iran-banks';

/**
 * Card-to-card: the payer moves rials to an Iranian bank card with their
 * banking app (F-803-b, contract.manual-transfer.md "Method kinds").
 */

const CARD_DIGITS = /^\d{16}$/;
/** `IR`, two check digits, 22 digits of account (ISO 13616). */
const SHEBA_SHAPE = /^IR\d{24}$/;
/** ISO 13616: the country and check digits move to the end, letters become 10..35, and the whole is 1 mod 97. */
const IBAN_MODULUS = BigInt(97);
const LETTER_BASE = 'A'.charCodeAt(0) - 10;

/** Luhn (ISO/IEC 7812): every second digit from the right doubled; the sum is a multiple of 10. */
function isLuhnValid(digits: string): boolean {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    const n = Number(d) * (i % 2 === 1 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return sum % 10 === 0;
}

function isShebaValid(sheba: string): boolean {
  const moved = sheba.slice(4) + sheba.slice(0, 4);
  const numeric = [...moved].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - LETTER_BASE))).join('');
  return BigInt(numeric) % IBAN_MODULUS === BigInt(1);
}

/** A shape check, then a checksum: a typo is told apart from a number of the wrong form. */
function checksummed(shape: RegExp, fold: (raw: string) => string, valid: (value: string) => boolean): FieldCheck {
  return (raw) => {
    if (typeof raw !== 'string') return { refused: 'invalid' };
    const value = fold(raw);
    if (!shape.test(value)) return { refused: 'invalid' };
    return valid(value) ? { value } : { refused: 'checksum' };
  };
}

/** A toman: some banking apps take the amount in toman, so a smaller offset could not be typed (F-804). */
const RIALS_PER_TOMAN = BigInt(10);

export const CARD_TO_CARD: ManualMethod = {
  kind: 'card_to_card',
  destinationFields: [
    { id: 'cardNumber', type: 'digits', public: true, check: checksummed(CARD_DIGITS, foldDigits, isLuhnValid) },
    {
      id: 'holderName',
      type: 'text',
      public: true,
      check: textCheck({ pattern: /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, max: 100, fold: foldToOneSpelling }),
    },
    {
      id: 'bankId',
      type: 'text',
      public: true,
      check: (raw) => (typeof raw === 'string' && BANK_IDS.has(raw) ? { value: raw } : { refused: 'invalid' }),
      fallback: (fields) => bankOfCard(String(fields['cardNumber'] ?? '')),
    },
    {
      id: 'sheba',
      type: 'text',
      public: true,
      optional: true,
      check: checksummed(SHEBA_SHAPE, (raw) => foldDigits(raw).toUpperCase(), isShebaValid),
    },
  ],
  proofFields: [
    RECEIPT_IMAGE,
    { id: 'trackingCode', type: 'text', check: textCheck({ pattern: /^[A-Za-z0-9]{4,40}$/, max: 40, fold: foldDigits }) },
    { id: 'sourceCardLast4', type: 'digits', check: textCheck({ pattern: /^\d{4}$/, max: 4, fold: foldDigits }) },
    PAID_AT,
  ],
  refProofField: 'trackingCode',
  // A bank tracking code is unique across Shetab, not per card.
  refNetwork: () => 'card',
  // Priced through the FX rate as a rial gateway (F-092-c).
  chargeCurrency: () => 'IRR',
  chargeDecimals: () => 0,
  uniqueStep: () => RIALS_PER_TOMAN,
  // A card has no watcher until the SMS reader (F-806).
  watcherFor: () => null,
};
