/**
 * The `card_to_card` kind (F-803-b): what a seller may enter as a card and
 * what a payer may send as proof, through the registry every caller uses.
 * A card number that fails Luhn, or a sheba that fails its checksum, is a typo
 * the payer would otherwise send money to.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { manualMethod, parseDestination, parseProof, publicDestination } from '../manual-methods';
import { IRAN_BANKS } from './iran-banks';

const CARD = manualMethod('card_to_card');
const MELLI = '6037991234567893';
const TEJARAT = '6273530000111123';
const UNKNOWN_BIN = '9999990000111126';
const SHEBA = 'IR930170000001234567890120';

const destination = (fields: Record<string, unknown>) => {
  if (!CARD) throw new Error('card_to_card is not registered');
  return parseDestination(CARD, fields);
};

describe('a card destination', () => {
  it('is registered under its kind', () => {
    expect(CARD?.kind).toBe('card_to_card');
  });

  it('accepts a card typed in Persian digits with spaces, stored as 16 ASCII digits', () => {
    const parsed = destination({ cardNumber: '۶۰۳۷ ۹۹۱۲ ۳۴۵۶ ۷۸۹۳', holderName: ' علی رضایی ' });
    expect(parsed).toEqual({ ok: true, fields: { cardNumber: MELLI, holderName: 'علی رضایی', bankId: 'melli' } });
  });

  it('refuses a number that fails Luhn as a checksum, and one of the wrong length as invalid', () => {
    expect(destination({ cardNumber: '6037991234567890', holderName: 'x' })).toEqual({ ok: false, refusals: [{ field: 'cardNumber', reason: 'checksum' }] });
    expect(destination({ cardNumber: '603799123456789', holderName: 'x' })).toEqual({ ok: false, refusals: [{ field: 'cardNumber', reason: 'invalid' }] });
  });

  it('derives the bank from the BIN, takes an override, and calls an unknown BIN other', () => {
    expect(destination({ cardNumber: TEJARAT, holderName: 'x' })).toMatchObject({ fields: { bankId: 'tejarat' } });
    expect(destination({ cardNumber: TEJARAT, holderName: 'x', bankId: 'mellat' })).toMatchObject({ fields: { bankId: 'mellat' } });
    expect(destination({ cardNumber: UNKNOWN_BIN, holderName: 'x' })).toMatchObject({ ok: true, fields: { bankId: 'other' } });
    expect(destination({ cardNumber: TEJARAT, holderName: 'x', bankId: 'no_such_bank' })).toEqual({ ok: false, refusals: [{ field: 'bankId', reason: 'invalid' }] });
  });

  it('takes an optional sheba, checked by its mod-97 checksum', () => {
    expect(destination({ cardNumber: MELLI, holderName: 'x', sheba: 'ir93 0170 0000 0123 4567 8901 20' })).toMatchObject({ fields: { sheba: SHEBA } });
    expect(destination({ cardNumber: MELLI, holderName: 'x', sheba: 'IR940170000001234567890120' })).toEqual({ ok: false, refusals: [{ field: 'sheba', reason: 'checksum' }] });
    expect(destination({ cardNumber: MELLI, holderName: 'x', sheba: 'DE930170000001234567890120' })).toEqual({ ok: false, refusals: [{ field: 'sheba', reason: 'invalid' }] });
  });

  it('names every refused field: a missing one and one the kind does not declare', () => {
    expect(destination({ cardNumber: MELLI, cvv2: '123' })).toEqual({
      ok: false,
      refusals: [{ field: 'holderName', reason: 'missing' }, { field: 'cvv2', reason: 'unknown_field' }],
    });
    if (!CARD) throw new Error('card_to_card is not registered');
    expect(parseDestination(CARD, 'not an object')).toEqual({ ok: false, refusals: [{ field: '', reason: 'invalid' }] });
  });

  it('shows the payer the card, its holder, its bank and its sheba', () => {
    const parsed = destination({ cardNumber: MELLI, holderName: 'x', sheba: SHEBA });
    if (!CARD || !parsed.ok) throw new Error('expected a card');
    expect(publicDestination(CARD, parsed.fields)).toEqual({ cardNumber: MELLI, holderName: 'x', bankId: 'melli', sheba: SHEBA });
  });

  it('charges rials, in whole rials, with a toman as the unique step and no watcher yet', () => {
    const parsed = destination({ cardNumber: MELLI, holderName: 'x' });
    if (!CARD || !parsed.ok) throw new Error('expected a card');
    expect([CARD.chargeCurrency(parsed.fields), CARD.chargeDecimals(parsed.fields), CARD.uniqueStep(parsed.fields)]).toEqual(['IRR', 0, BigInt(10)]);
    expect([CARD.watcherFor(parsed.fields), CARD.refNetwork(parsed.fields), CARD.refProofField]).toEqual([null, 'card', 'trackingCode']);
  });
});

describe('a card payment\'s proof', () => {
  const proof = (input: unknown, required: readonly string[]) => {
    if (!CARD) throw new Error('card_to_card is not registered');
    return parseProof(CARD, input, required);
  };

  it('holds what the seller required, folding a tracking code\'s digits', () => {
    expect(proof({ trackingCode: '۱۲۳۴۵۶', receiptImage: 'tenant/t1/proof/p1.jpg', paidAt: '2026-10-15T08:00:00+03:30' }, ['trackingCode', 'receiptImage'])).toEqual({
      ok: true,
      fields: { trackingCode: '123456', receiptImage: 'tenant/t1/proof/p1.jpg', paidAt: '2026-10-15T04:30:00.000Z' },
    });
  });

  it('refuses a missing required field, a bad last-4 and a field the kind does not declare', () => {
    expect(proof({ sourceCardLast4: '12a4', txHash: 'abc' }, ['trackingCode'])).toEqual({
      ok: false,
      refusals: [{ field: 'trackingCode', reason: 'missing' }, { field: 'sourceCardLast4', reason: 'invalid' }, { field: 'txHash', reason: 'unknown_field' }],
    });
  });
});

describe('the bank table', () => {
  // The panel draws the card from the generated copy of this contract (F-803-g); the two must not drift (ADR-0036).
  it('is exactly contracts/billing/iran-banks.json', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, '../../../../../../../contracts/billing/iran-banks.json'), 'utf8')) as { iranBanks: Record<string, { bins: string[]; colors: string[] }> };
    expect(Object.fromEntries(IRAN_BANKS.map((b) => [b.id, { bins: [...b.bins], colors: [...b.colors] }]))).toEqual(fixture.iranBanks);
  });
});
