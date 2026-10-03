import { ActionDelivery, afterRefusal, deliveryItem, DELIVERY_LEASE_MS } from './delivery';

/**
 * F-038-g2 (ADR-0109 points 10, 11): the seams worker-service delivers a
 * scheduled suggestion through — take what is due, run the safety floor last,
 * then mark it sent, or stop it.
 *
 * The failures worth a spec: a suggestion told after its deadline; one told
 * twice because two takes saw it; the floor skipped, or charged for a
 * message then marked stopped; a refusal that could wait (the budget reopens
 * tomorrow, the deadline is in three days) thrown away instead of moved; and
 * a delivery item that tells the worker something the audit row does not say.
 */

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-000000000001';
const ACTION = '00000000-0000-4000-8000-0000000000c1';
const GRANT = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-10-05T09:20:00Z');
const HOUR = 3_600_000;

describe('afterRefusal (F-038-g2)', () => {
  const deadline = new Date(NOW.getTime() + 72 * HOUR);
  it('moves the suggestion to when it may go, if that is before its deadline', () => {
    const retry = new Date(NOW.getTime() + 20 * HOUR);
    expect(afterRefusal(deadline, retry, NOW)).toEqual({ reschedule: retry });
  });
  it('stops it when that is past the deadline, or never', () => {
    expect(afterRefusal(deadline, new Date(deadline.getTime() + 1), NOW)).toEqual({ stop: true });
    expect(afterRefusal(deadline, null, NOW)).toEqual({ stop: true });
  });
  it('with no deadline, moves it up to a week ahead', () => {
    expect(afterRefusal(null, new Date(NOW.getTime() + 24 * HOUR), NOW)).toEqual({ reschedule: new Date(NOW.getTime() + 24 * HOUR) });
    expect(afterRefusal(null, new Date(NOW.getTime() + 8 * 24 * HOUR), NOW)).toEqual({ stop: true });
  });
});

describe('deliveryItem (F-038-g2)', () => {
  it('is the labelled message plus what the template needs, read from the audit row itself', () => {
    const item = deliveryItem({
      id: ACTION,
      tenantId: TENANT,
      subjectKind: 'user',
      subjectId: USER,
      actionType: 'renew',
      status: 'scheduled',
      templateKey: 'suggestion.renew',
      renderedBy: 'template',
      renderedText: null,
      deadline: new Date('2026-10-08T00:00:00Z'),
      reasons: [{ code: 'suggest_variant', grantId: GRANT, fromVariantId: 'v50', variantId: 'v50', price: '200000.00', currencyCode: 'IRR' }],
    });
    expect(item).toEqual({
      actionId: ACTION,
      tenantId: TENANT,
      subjectKind: 'user',
      subjectId: USER,
      actionType: 'renew',
      label: 'suggestion',
      templateKey: 'suggestion.renew',
      renderedBy: 'template',
      text: null,
      grantId: GRANT,
      variantId: 'v50',
      fromVariantId: 'v50',
      price: { amount: '200000.00', currencyCode: 'IRR' },
      amount: null,
      offer: null,
      payment: null,
      usage: null,
      reseller: null,
      deadline: '2026-10-08T00:00:00.000Z',
    });
  });
});

describe('ActionDelivery (F-038-g2)', () => {
  const row = { id: ACTION, tenantId: TENANT, subjectKind: 'user', subjectId: USER, deadline: new Date(NOW.getTime() + 72 * HOUR) };

  function harness(floor: { pass: true } | { pass: false; suppressedBy: string; until: Date | null }, found: unknown = row) {
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => []),
      aiAction: { findFirst: vi.fn(async () => found), updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const safety = { check: vi.fn(async () => floor) };
    return { tx, safety, delivery: new ActionDelivery(prisma as never, safety as never, {} as never, {} as never) };
  }

  it('runs the floor as an engine message, for the action subject in its own tenant', async () => {
    const { delivery, safety } = harness({ pass: true });
    await expect(delivery.floor(TENANT, ACTION, NOW)).resolves.toEqual({ pass: true });
    expect(safety.check).toHaveBeenCalledWith(TENANT, { tenantId: TENANT, kind: 'user', id: USER }, 'engine', NOW);
  });

  it('moves a suggestion the budget refuses until it reopens, before the deadline', async () => {
    const until = new Date(NOW.getTime() + 10 * HOUR);
    const { delivery, tx } = harness({ pass: false, suppressedBy: 'attention_budget', until });
    await expect(delivery.floor(TENANT, ACTION, NOW)).resolves.toEqual({ pass: false, suppressedBy: 'attention_budget', rescheduledTo: until.toISOString() });
    expect(tx.aiAction.updateMany).toHaveBeenCalledWith({ where: { id: ACTION, tenantId: TENANT, status: 'scheduled' }, data: { scheduledFor: until } });
  });

  it('stops one the floor refuses for good, with the floor step', async () => {
    const { delivery, tx } = harness({ pass: false, suppressedBy: 'cross_tenant', until: null });
    await expect(delivery.floor(TENANT, ACTION, NOW)).resolves.toEqual({ pass: false, suppressedBy: 'cross_tenant' });
    expect(tx.aiAction.updateMany).toHaveBeenCalledWith({ where: { id: ACTION, tenantId: TENANT, status: 'scheduled' }, data: { status: 'suppressed', suppressedBy: 'cross_tenant' } });
  });

  it('answers null for an action that is not scheduled in that tenant, and runs no floor', async () => {
    const { delivery, safety } = harness({ pass: true }, null);
    await expect(delivery.floor(TENANT, ACTION, NOW)).resolves.toBeNull();
    expect(safety.check).not.toHaveBeenCalled();
  });

  it('marks sent only a scheduled action, with its time', async () => {
    const { delivery, tx } = harness({ pass: true });
    await expect(delivery.sent(TENANT, ACTION, NOW)).resolves.toEqual({ sent: true });
    expect(tx.aiAction.updateMany).toHaveBeenCalledWith({ where: { id: ACTION, tenantId: TENANT, status: 'scheduled' }, data: { status: 'sent', sentAt: NOW } });
  });

  it('a muted or later claim stops or moves it the same way', async () => {
    const { delivery, tx } = harness({ pass: true });
    await expect(delivery.stop(TENANT, ACTION, 'muted', null, NOW)).resolves.toEqual({ suppressedBy: 'muted' });
    expect(tx.aiAction.updateMany).toHaveBeenLastCalledWith({ where: { id: ACTION, tenantId: TENANT, status: 'scheduled' }, data: { status: 'suppressed', suppressedBy: 'muted' } });
    const retry = new Date(NOW.getTime() + 5 * HOUR);
    await expect(delivery.stop(TENANT, ACTION, 'after_retention', retry, NOW)).resolves.toEqual({ rescheduledTo: retry.toISOString() });
  });

  it('leases what it takes, so a second take does not see it', () => {
    expect(DELIVERY_LEASE_MS).toBe(10 * 60_000);
  });
});
