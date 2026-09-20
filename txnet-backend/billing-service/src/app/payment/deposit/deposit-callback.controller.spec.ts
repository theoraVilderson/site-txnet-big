import type { Request } from 'express';

import { callbackRateLimitSubject } from './deposit-callback.controller';

/**
 * The callback is the one route bucketed on something that is not a caller, so
 * what it picks as the subject *is* the limit (F-092-j, `contract.deposit.md`).
 *
 * It used to pick the authority alone. Zarinpal sends one; NOWPayments and
 * OxaPay return with `?p=` and nothing else, and every one of those fell into a
 * single `none` bucket the Redis key scopes only by tenant — so one tenant's
 * payers shared 30 returns per 15 minutes, and 30 empty requests closed the
 * door for all of them (F-104-u).
 */
function req(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

const PAYMENT = '3f1c9d6e-5a2b-4c8d-9e7f-0a1b2c3d4e5f';

describe('callbackRateLimitSubject', () => {
  it('counts the authority when the gateway sent one', () => {
    expect(callbackRateLimitSubject(req({ Authority: 'A000000001', p: PAYMENT }))).toBe('A000000001');
  });

  it('counts the payment the URL was minted for when there is no authority', () => {
    expect(callbackRateLimitSubject(req({ p: PAYMENT }))).toBe(PAYMENT);
  });

  it('gives two authority-less returns of one tenant separate budgets', () => {
    const other = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    expect(callbackRateLimitSubject(req({ p: PAYMENT }))).not.toBe(callbackRateLimitSubject(req({ p: other })));
  });

  it('lowercases the payment id, so one payment is one bucket however the URL was cased', () => {
    expect(callbackRateLimitSubject(req({ p: PAYMENT.toUpperCase() }))).toBe(PAYMENT);
  });

  it('shares one bucket for a return that names neither — there is nothing to tell them apart', () => {
    expect(callbackRateLimitSubject(req({}))).toBe('none');
    expect(callbackRateLimitSubject(req({ p: 'not-a-uuid' }))).toBe('none');
  });

  it('does not let a repeated parameter split a payment off its own bucket', () => {
    expect(callbackRateLimitSubject(req({ Authority: ['A1', 'A2'], p: PAYMENT }))).toBe(PAYMENT);
  });
});
