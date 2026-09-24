import { describe, expect, it } from 'vitest';
import { createGatewaySchema, depositTaxSchema, updateGatewaySchema } from './gateway-admin.schema';

/**
 * The wire refuses money finer than the column that stores it (F-104-ad).
 *
 * `payment_gateway.feeFloor` is `numeric(18, 2)` and `feeValue` is
 * `numeric(18, 4)`. Postgres does not refuse a finer value, it rounds it —
 * so `0.125` was accepted, written as `0.13`, and the operator who typed it
 * was told nothing. The scales below are that table's, not a guess.
 */

const at = (body: Record<string, unknown>) => updateGatewaySchema.safeParse(body);
const errorOf = (body: Record<string, unknown>) => {
  const parsed = at(body);
  expect(parsed.success).toBe(false);
  return parsed.success ? '' : parsed.error.issues[0].message;
};

describe('gateway admin schema decimals', () => {
  it('takes a cent, refuses anything under one, on every 2-place column', () => {
    for (const k of ['minAcceptAmount', 'maxAcceptAmount', 'feeFloor', 'feeCeiling']) {
      expect(at({ [k]: '12.50' }).success).toBe(true);
      expect(at({ [k]: '12' }).success).toBe(true);
      // A bound may be dropped entirely; that is not a precision question.
      expect(at({ [k]: null }).success).toBe(true);
      expect(errorOf({ [k]: '0.125' })).toBe(`${k} must be a decimal string with at most 2 places`);
    }
  });

  it('takes four places on feeValue — a percentage is finer than the money it is taken on', () => {
    expect(at({ feeValue: '2.3456' }).success).toBe(true);
    expect(errorOf({ feeValue: '2.34567' })).toBe('feeValue must be a decimal string with at most 4 places');
  });

  it('keeps eight places on a rate, where the column has them', () => {
    for (const k of ['staticRate', 'minRate', 'maxRate', 'roundingStep']) {
      expect(at({ [k]: '0.00012345' }).success).toBe(true);
      expect(errorOf({ [k]: '0.000123456' })).toBe(`${k} must be a decimal string with at most 8 places`);
    }
  });

  it('takes four places on a tax rate, at both levels, and null inherits (F-104-ag)', () => {
    expect(at({ taxRatePercent: '9.1234' }).success).toBe(true);
    expect(at({ taxRatePercent: null }).success).toBe(true);
    expect(errorOf({ taxRatePercent: '9.12345' })).toBe('taxRatePercent must be a decimal string with at most 4 places');

    expect(depositTaxSchema.safeParse({ taxRatePercent: '9.1234' }).success).toBe(true);
    expect(depositTaxSchema.safeParse({ taxRatePercent: null }).success).toBe(true);
    const finer = depositTaxSchema.safeParse({ taxRatePercent: '9.12345' });
    expect(finer.success ? '' : finer.error.issues[0].message).toBe('taxRatePercent must be a decimal string with at most 4 places');
    expect(depositTaxSchema.safeParse({}).success).toBe(false);
  });

  it('still refuses what it always refused: a negative, a comma, an empty string', () => {
    expect(at({ feeFloor: '-1' }).success).toBe(false);
    expect(at({ feeValue: '1,5' }).success).toBe(false);
    expect(at({ feeValue: '' }).success).toBe(false);
    expect(at({ feeValue: 2.5 }).success).toBe(false);
  });

  it('holds on create as it does on update', () => {
    const body = { source: 'platform', displayName: 'Zarinpal', feeValue: '1.5' } as const;
    expect(createGatewaySchema.safeParse(body).success).toBe(true);
    expect(createGatewaySchema.safeParse({ ...body, feeCeiling: '0.125' }).success).toBe(false);
  });
});
