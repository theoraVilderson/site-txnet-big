import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { InvalidDepositPresets, MAX_DEPOSIT_PRESETS, automaticPresets, normalizePresets, resolvePresets } from './deposit-presets';

/**
 * Quick amounts on the top-up page (F-092-v): a tenant's default list, which a
 * gateway may override (the user's call, 2026-09-13).
 *
 * - **One set of rules for both lists.** Base-currency decimals with two places
 *   (ADR-0019, C-02), positive, no repeats, ascending, a handful at most — a
 *   list the panel can lay out as buttons without judging it.
 * - **The gateway's list wins when it has one**, otherwise the tenant's; either
 *   way an amount the gateway would refuse is never offered. Empty means the
 *   panel falls back to its automatic ladder, so nothing changes for a tenant
 *   that configured nothing.
 */
const d = (v: string) => new Prisma.Decimal(v);

describe('normalizePresets', () => {
  it('sorts, removes repeats and writes two decimals', () => {
    expect(normalizePresets(['5', '2.5', '2', '5.00'])).toEqual(['2.00', '2.50', '5.00']);
  });

  it('accepts an empty list — it means "inherit"', () => {
    expect(normalizePresets([])).toEqual([]);
  });

  it.each([
    ['zero', ['0']],
    ['a negative', ['-1']],
    ['more places than a column holds', ['1.00005']],
    ['not a number', ['abc']],
    ['an empty string', ['']],
  ])('refuses %s', (_label, values) => {
    expect(() => normalizePresets(values)).toThrow(InvalidDepositPresets);
  });

  it(`refuses more than ${MAX_DEPOSIT_PRESETS} amounts`, () => {
    const many = Array.from({ length: MAX_DEPOSIT_PRESETS + 1 }, (_, i) => String(i + 1));
    expect(() => normalizePresets(many)).toThrow(InvalidDepositPresets);
  });
});

describe('resolvePresets', () => {
  const range = { min: d('1'), max: d('100') };

  it("uses the gateway's own list when it has one", () => {
    expect(resolvePresets([d('3'), d('7')], [d('2'), d('2.5')], range)).toEqual(['3.00', '7.00']);
  });

  it("falls back to the tenant's default when the gateway has none", () => {
    expect(resolvePresets([], [d('2'), d('2.5')], range)).toEqual(['2.00', '2.50']);
  });

  it('never offers an amount outside what the gateway accepts', () => {
    expect(resolvePresets([], [d('0.5'), d('2'), d('150')], range)).toEqual(['2.00']);
  });

  // 2026-10-15: the ladder was the panel's alone, so the bot showed no quick amount for the same gateway.
  it('answers the automatic ladder when neither list has anything, or nothing of it fits', () => {
    expect(resolvePresets([], [], range)).toEqual(automaticPresets(range));
    expect(resolvePresets([], null, range)).toEqual(automaticPresets(range));
    expect(resolvePresets([d('500')], [], range)).toEqual(automaticPresets(range));
  });

  it('bounds only by the side a gateway set — a missing minimum or maximum is no limit', () => {
    const list = [d('0.5'), d('2'), d('150')];
    expect(resolvePresets(list, [], { min: null, max: null })).toEqual(['0.50', '2.00', '150.00']);
    expect(resolvePresets(list, [], { min: d('1'), max: null })).toEqual(['2.00', '150.00']);
    expect(resolvePresets(list, [], { min: null, max: d('100') })).toEqual(['0.50', '2.00']);
  });
});

// Moved from the panel (2026-10-15): one home, so the panel and the bot offer the same amounts.
describe('automaticPresets', () => {
  it("comes from the gateway's own range, not from a constant, with its maximum last", () => {
    expect(automaticPresets({ min: d('1'), max: d('500') })).toEqual(['1.00', '2.00', '5.00', '10.00', '20.00', '500.00']);
  });

  it('drops every step a narrow gateway cannot take', () => {
    expect(automaticPresets({ min: d('100'), max: d('150') })).toEqual(['100.00', '150.00']);
  });

  it('offers nothing rather than an unusable step when the range is empty', () => {
    expect(automaticPresets({ min: d('100'), max: d('50') })).toEqual([]);
    expect(automaticPresets({ min: null, max: d('0') })).toEqual([]);
  });

  it('builds the ladder for a gateway that left either end of its range open', () => {
    expect(automaticPresets({ min: null, max: null })).toEqual(['1.00', '2.00', '5.00', '10.00', '20.00', '50.00']);
    expect(automaticPresets({ min: d('5'), max: null })).toEqual(['5.00', '10.00', '25.00', '50.00', '100.00', '250.00']);
    expect(automaticPresets({ min: null, max: d('8') })).toEqual(['1.00', '2.00', '5.00', '8.00']);
  });
});
