import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { MySuggestionController } from './my-suggestion.controller';
import { pickCard, type CardRow, type MySuggestions } from './my-suggestion';

/**
 * F-038-h (ADR-0109 point 11): the panel shows the user's current suggestion as
 * one card. Current = the newest one told to them in the last 7 days that is
 * still open: not bought, not dismissed, its deadline not passed. Whose it is
 * comes off the gate's identity, never off the request.
 */
const now = new Date('2026-10-02T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(now.getTime() - ms);

const row = (over: Partial<CardRow> = {}): CardRow => ({
  id: 'a-1',
  actionType: 'renew',
  status: 'sent',
  sentAt: ago(H),
  deadline: new Date(now.getTime() + 3 * D),
  convertedAt: null,
  reasons: [{ code: 'suggest_variant', grantId: 'g-1', fromVariantId: 'v-1', variantId: 'v-1', price: '10.00', currencyCode: 'USD' }],
  ...over,
});

describe('pickCard (F-038-h)', () => {
  it('a sent, open suggestion is the card, labelled, with what the panel names and links to', () => {
    expect(pickCard([row()], now)).toEqual({
      actionId: 'a-1',
      actionType: 'renew',
      label: 'suggestion',
      grantId: 'g-1',
      variantId: 'v-1',
      fromVariantId: 'v-1',
      deadline: new Date(now.getTime() + 3 * D).toISOString(),
    });
  });

  it('the newest of several', () => {
    expect(pickCard([row({ id: 'old', sentAt: ago(2 * D) }), row({ id: 'new', sentAt: ago(H) })], now)?.actionId).toBe('new');
  });

  it.each([
    ['not sent', { status: 'scheduled' }],
    ['dismissed', { status: 'dismissed' }],
    ['accepted', { status: 'accepted' }],
    ['bought', { convertedAt: ago(H) }],
    ['past its deadline', { deadline: ago(1) }],
    ['told more than 7 days ago', { sentAt: ago(7 * D + 1), deadline: null }],
    ['a type the card does not tell', { actionType: 'win_back' }],
    ['without the plan it names', { reasons: [{ code: 'expected_margin' }] }],
  ])('no card when %s', (_why, over) => {
    expect(pickCard([row(over as Partial<CardRow>)], now)).toBeNull();
  });
});

describe('MySuggestionController (F-038-h)', () => {
  const identity = { userId: 'u-1', tenantId: 't-1', roleId: 'r', sessionId: 's', permissions: [] };
  const req = { identity } as unknown as Request;
  const service = () => ({
    current: vi.fn<MySuggestions['current']>(async () => null),
    dismiss: vi.fn<MySuggestions['dismiss']>(async () => ({ dismissed: true })),
    optOut: vi.fn<MySuggestions['optOut']>(async () => ({ actionType: 'renew' })),
  });

  it('every route acts as the gate’s user in the gate’s tenant', async () => {
    const s = service();
    const c = new MySuggestionController(s);
    await c.current(req);
    await c.dismiss('a-1', req);
    await c.optOut('a-1', req);
    expect(s.current).toHaveBeenCalledWith('t-1', 'u-1', expect.any(Date));
    expect(s.dismiss).toHaveBeenCalledWith('t-1', 'u-1', 'a-1', expect.any(Date));
    expect(s.optOut).toHaveBeenCalledWith('t-1', 'u-1', 'a-1', expect.any(Date));
  });

  it('an action that is not the caller’s is a 404, for dismiss and opt-out alike', async () => {
    const s = service();
    s.dismiss.mockResolvedValueOnce(null);
    s.optOut.mockResolvedValueOnce(null);
    const c = new MySuggestionController(s);
    await expect(c.dismiss('a-x', req)).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.optOut('a-x', req)).rejects.toBeInstanceOf(NotFoundException);
  });
});
