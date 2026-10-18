import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { ACTIVITY_WINDOW_DAYS, SettingsActivity, activityOf } from './settings-activity';

/**
 * F-038-j3: what each action type actually did lately, so the settings page
 * can say "sent 20 times" or "never sent: the threshold holds it back"
 * instead of a bare checkbox.
 *
 * The failures worth a spec: a type the threshold silences shown as working
 * (the confidences seen must reach the page); a discount type shown as ready
 * with no active offer; a type the engine cannot propose yet shown as idle by
 * chance; another tenant's rows counted; the window drifting.
 */

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-10-18T12:00:00Z');
const DAY = 86_400_000;

type Row = Parameters<typeof activityOf>[0]['rows'][number];
const row = (actionType: string, status: string, suppressedBy: string | null, count: number, min: string, max: string): Row =>
  ({ actionType, status, suppressedBy, _count: { _all: count }, _min: { confidence: new Prisma.Decimal(min) }, _max: { confidence: new Prisma.Decimal(max) } }) as Row;

describe('activityOf (F-038-j3)', () => {
  const types = ['renew', 'win_back', 'retain_offer', 'trial_convert'] as never[];

  it('counts what went out, what the threshold held, what else held, what is queued — per type', () => {
    const out = activityOf({
      types,
      rows: [
        row('renew', 'sent', null, 3, '0.6', '0.7'),
        row('renew', 'accepted', null, 1, '0.7', '0.7'),
        row('renew', 'dismissed', null, 1, '0.6', '0.6'),
        row('renew', 'scheduled', null, 2, '0.6', '0.6'),
        row('renew', 'suppressed', 'cooldown', 4, '0.6', '0.6'),
        row('renew', 'expired', null, 1, '0.6', '0.6'),
        row('win_back', 'suppressed', 'confidence_threshold', 4, '0.55', '0.55'),
      ],
      activeOfferTypes: [],
    });
    expect(out.find((x) => x.type === 'renew')).toEqual({
      type: 'renew', sent: 5, queued: 2, heldByThreshold: 0, heldOtherwise: 5, confidence: { min: '0.6', max: '0.7' }, waitsOn: null,
    });
    expect(out.find((x) => x.type === 'win_back')).toMatchObject({ sent: 0, heldByThreshold: 4, confidence: { min: '0.55', max: '0.55' } });
  });

  it('a type with no rows says so with no confidence, never a made-up one', () => {
    const out = activityOf({ types, rows: [], activeOfferTypes: ['retain_offer'] });
    expect(out.map((x) => x.type)).toEqual(types);
    expect(out[0]).toEqual({ type: 'renew', sent: 0, queued: 0, heldByThreshold: 0, heldOtherwise: 0, confidence: null, waitsOn: null });
  });

  it('a discount type with no active offer waits on one; with one it waits on nothing', () => {
    expect(activityOf({ types, rows: [], activeOfferTypes: [] }).find((x) => x.type === 'retain_offer')?.waitsOn).toBe('active_offer');
    expect(activityOf({ types, rows: [], activeOfferTypes: ['retain_offer'] }).find((x) => x.type === 'retain_offer')?.waitsOn).toBeNull();
  });

  it('a type the engine cannot propose yet says so, whatever else is true', () => {
    expect(activityOf({ types, rows: [], activeOfferTypes: [] }).find((x) => x.type === 'trial_convert')?.waitsOn).toBe('not_available');
  });
});

describe('SettingsActivity (F-038-j3)', () => {
  it('reads the gate’s tenant over the window, and which offer types are active', async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      aiAction: { groupBy: vi.fn(async () => [row('renew', 'sent', null, 2, '0.6', '0.6')]) },
      aiOffer: { findMany: vi.fn(async () => [{ actionType: 'retain_offer' }]) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService;
    const out = await new SettingsActivity(prisma).read(TENANT, NOW);

    expect(ACTIVITY_WINDOW_DAYS).toBe(30);
    expect(tx.aiAction.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: TENANT, createdAt: { gte: new Date(NOW.getTime() - 30 * DAY) } },
    }));
    expect(tx.aiOffer.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT, isActive: true } }));
    expect(out.windowDays).toBe(30);
    expect(out.types.find((x) => x.type === 'renew')).toMatchObject({ sent: 2 });
    expect(out.types.find((x) => x.type === 'retain_offer')?.waitsOn).toBeNull();
  });
});
