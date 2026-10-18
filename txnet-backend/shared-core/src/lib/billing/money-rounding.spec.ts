/**
 * Money is rounded once, to its currency's places, by who would bear the error
 * (ADR-0153, F-116-p). What breaks quietly:
 *
 *  - **a literal 2.** A rial has no cents: 1000.5 IRR stored at two places is a
 *    fraction of a rial no gateway charges and no owner withdraws;
 *  - **the wrong direction.** A charge rounded down leaves the platform short,
 *    a credit rounded up credits money that never arrived;
 *  - **a positive amount converted to nothing.** 1,000 IRR into USD is 0.00095:
 *    half up it is 0.00, and the owner's money leaves the books;
 *  - **parts that do not sum to their whole.** Each share rounded alone loses
 *    the remainder.
 */
import { Prisma } from '@prisma/client';

import {
  fromMinorUnits,
  minorUnit,
  roundCharge,
  roundConverted,
  roundCredit,
  roundHold,
  roundRate,
  roundRateToStep,
  roundRatio,
  splitWhole,
  toMinorUnits,
} from './money-rounding';

const d = (v: string) => new Prisma.Decimal(v);
const s = (v: Prisma.Decimal) => v.toFixed();

describe('money rounding (ADR-0153)', () => {
  it('rounds to the places it is given, never to two', () => {
    expect(s(roundConverted(d('1000.5'), 0))).toBe('1001');
    expect(s(roundConverted(d('1.2345'), 3))).toBe('1.235');
    expect(s(minorUnit(0))).toBe('1');
    expect(s(minorUnit(3))).toBe('0.001');
  });

  it('charges up, credits and holds down', () => {
    expect(s(roundCharge(d('10.001'), 2))).toBe('10.01');
    expect(s(roundCredit(d('10.009'), 2))).toBe('10');
    expect(s(roundHold(d('10.009'), 2))).toBe('10');
  });

  it('converts half up, and a positive amount never to nothing', () => {
    expect(s(roundConverted(d('0.005'), 2))).toBe('0.01');
    expect(s(roundConverted(d('0.00095'), 2))).toBe('0.01');
    expect(s(roundConverted(d('0'), 2))).toBe('0');
  });

  it('a credit may round to nothing: a fraction that did not arrive is not credited', () => {
    expect(s(roundCredit(d('0.004'), 2))).toBe('0');
  });

  it('keeps the caller’s precision until the rounding', () => {
    const Wide = Prisma.Decimal.clone({ precision: 64 });
    const v = new Wide('123456789012345678.123456789012345678').mul('1.000000000000000001');
    expect(s(roundCharge(v, 2))).toBe('123456789012345678.25');
  });

  it('splits a whole into parts that sum to it, the remainder on the largest', () => {
    const parts = splitWhole(d('10.00'), [BigInt(1), BigInt(1), BigInt(1)], 2);
    expect(parts.map(s)).toEqual(['3.34', '3.33', '3.33']);
    expect(s(parts.reduce((a, b) => a.plus(b)))).toBe('10');
    expect(splitWhole(d('0.01'), [BigInt(1), BigInt(5)], 2).map(s)).toEqual(['0', '0.01']);
  });

  it('refuses to split a whole not yet at its places', () => {
    expect(() => splitWhole(d('1.005'), [BigInt(1)], 2)).toThrow(RangeError);
  });

  it('moves between an amount and its minor units, refusing one not rounded to them', () => {
    expect(toMinorUnits(d('12.34'), 2)).toBe(BigInt(1234));
    expect(toMinorUnits(d('1500'), 0)).toBe(BigInt(1500));
    expect(() => toMinorUnits(d('12.345'), 2)).toThrow(RangeError);
    expect(s(fromMinorUnits(BigInt(1234), 2))).toBe('12.34');
  });

  it('refuses places that are not a whole number of digits', () => {
    expect(() => roundCharge(d('1'), -1)).toThrow(RangeError);
    expect(() => roundCharge(d('1'), 1.5)).toThrow(RangeError);
  });

  it('rounds a rate half up at its scale, and to a gateway step up or to the nearest', () => {
    expect(s(roundRate(d('0.123456785'), 8))).toBe('0.12345679');
    expect(s(roundRateToStep(d('1234'), d('100'), 'up'))).toBe('1300');
    expect(s(roundRateToStep(d('1234'), d('100'), 'nearest'))).toBe('1200');
  });

  it('rounds a ratio shown half up', () => {
    expect(s(roundRatio(d('33.335'), 2))).toBe('33.34');
  });
});
