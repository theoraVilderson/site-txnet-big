/**
 * The holds queue (F-027-at, ADR-0080 decision 3). What would break silently:
 *
 *  - **a second path for consumption.** Releasing a hold must not touch the
 *    hold or a Grant here: it queues an outbox event and the meter does the
 *    rest, so deduplication and every rule of the normal path apply to it;
 *  - **whose holds.** A hold on a panel outside the scope is absent from the
 *    list and `not_found` by id, and a reseller is refused before anything is
 *    read;
 *  - **the record.** A write-off is never charged, needs a reason, and happens
 *    once: a second click does not rewrite who decided;
 *  - **the figure.** Bytes are BIGINTs; they leave as decimal strings, never
 *    as numbers that round past 2^53.
 */
import { HoldReason, TenantType, UsageDispositionState } from '@prisma/client';
import { OutboxEventType, USAGE_RELEASE_AGGREGATE } from '@txnet-backend/shared-core';

import { PanelScopeRefused } from './panel-scope';
import { SystemsRefused } from './systems-read';
import { UsageHoldsService } from './usage-holds';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const OTHER_ADMIN = '55555555-5555-4555-8555-555555555555';
const PLATFORM_PANEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESELLER_PANEL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN_HOLD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONFIG = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as Row)) return (v as { in: unknown[] }).in.includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

function harness() {
  const panels: Row[] = [
    { id: PLATFORM_PANEL, tenantId: null, ownershipType: 'platform', name: 'de-fra-1' },
    { id: RESELLER_PANEL, tenantId: RESELLER, ownershipType: 'tenant', name: 'their-own' },
  ];
  const hold = (id: string, panelId: string): Row => ({
    id, configId: CONFIG, panelId, upBytes: BigInt('9007199254740993'), downBytes: BigInt(7), reason: HoldReason.attribution_ambiguous,
    state: UsageDispositionState.pending, heldFrom: new Date('2026-09-24T08:00:00Z'), heldAt: new Date('2026-09-24T08:01:00Z'),
    resolvedAt: null, resolvedByAdminId: null, resolutionNote: null,
  });
  const holds: Row[] = [hold(HOLD, PLATFORM_PANEL), hold(FOREIGN_HOLD, RESELLER_PANEL)];
  const outbox: Row[] = [];
  const tenants = new Map([
    [OWNER, TenantType.platform_owner],
    [RESELLER, TenantType.reseller],
  ]);
  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        tenants.has(where.id) ? { tenantType: tenants.get(where.id) } : null,
    },
    panel: {
      findMany: async ({ where }: { where: Row }) =>
        panels.filter((p) => matches(p, where)).map((p) => ({ id: p['id'], name: p['name'] })),
    },
    usageHold: {
      findMany: async ({ where }: { where: Row }) => holds.filter((h) => matches(h, where)).map((h) => ({ ...h })),
      findFirst: async ({ where }: { where: Row }) => {
        const h = holds.find((row) => matches(row, where));
        return h ? { ...h } : null;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = holds.filter((h) => matches(h, where));
        hit.forEach((h) => Object.assign(h, data));
        return { count: hit.length };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: Row }) => {
        outbox.push(data);
        return data;
      },
    },
  };
  return { service: new UsageHoldsService(prisma as never), holds, outbox };
}

const owner = { adminId: ADMIN, tenantId: OWNER };
const reseller = { adminId: ADMIN, tenantId: RESELLER };

describe('UsageHoldsService', () => {
  it("lists the platform's holds only, bytes as decimal strings, with the panel's name", async () => {
    const { service } = harness();
    const page = await service.holds(owner, {});

    expect(page.items.map((h) => h.id)).toEqual([HOLD]);
    expect(page.items[0]).toMatchObject({ panelName: 'de-fra-1', upBytes: '9007199254740993', downBytes: '7' });
    expect(() => JSON.stringify(page)).not.toThrow();
    expect(page.next).toBeNull();
  });

  it('refuses a reseller before reading a hold, on every route', async () => {
    const { service, holds, outbox } = harness();
    await expect(service.holds(reseller, {})).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.release(reseller, HOLD, {})).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.writeOff(reseller, HOLD, { note: 'x' })).rejects.toBeInstanceOf(PanelScopeRefused);
    expect(outbox).toHaveLength(0);
    expect(holds[0]['state']).toBe(UsageDispositionState.pending);
  });

  it('releases by queueing an outbox event for the meter, and leaves the hold to the meter', async () => {
    const { service, holds, outbox } = harness();

    const answer = await service.release(owner, HOLD, { note: 'client-a is this config' });

    expect(answer).toEqual({ id: HOLD, state: UsageDispositionState.pending, release: 'queued' });
    expect(outbox).toEqual([
      {
        aggregate: USAGE_RELEASE_AGGREGATE,
        aggregateId: HOLD,
        type: OutboxEventType.USAGE_RELEASE,
        payload: { holdId: HOLD, adminId: ADMIN, note: 'client-a is this config' },
      },
    ]);
    // Not flipped here: the consumer flips it in the transaction that bills it.
    expect(holds[0]['state']).toBe(UsageDispositionState.pending);
  });

  it('answers not_found for a hold outside the scope, and already_resolved for one that is resolved', async () => {
    const { service, holds, outbox } = harness();
    await expect(service.release(owner, FOREIGN_HOLD, {})).rejects.toMatchObject({ reason: 'not_found' });
    await expect(service.writeOff(owner, FOREIGN_HOLD, { note: 'x' })).rejects.toBeInstanceOf(SystemsRefused);
    expect(holds[1]['state']).toBe(UsageDispositionState.pending);

    holds[0]['state'] = UsageDispositionState.released;
    await expect(service.release(owner, HOLD, {})).rejects.toMatchObject({ reason: 'already_resolved' });
    expect(outbox).toHaveLength(0);
  });

  it('writes a hold off once, recording who and why, and never charges it', async () => {
    const { service, holds, outbox } = harness();

    const off = await service.writeOff(owner, HOLD, { note: 'test traffic from our own probe' });
    expect(off).toMatchObject({ id: HOLD, state: UsageDispositionState.written_off, resolvedByAdminId: ADMIN,
      resolutionNote: 'test traffic from our own probe', upBytes: '9007199254740993' });
    expect(off.resolvedAt).toBeInstanceOf(Date);

    await expect(service.writeOff({ ...owner, adminId: OTHER_ADMIN }, HOLD, { note: 'again' })).rejects.toMatchObject({
      reason: 'already_resolved',
    });
    expect(holds[0]).toMatchObject({ resolvedByAdminId: ADMIN, resolutionNote: 'test traffic from our own probe' });
    expect(outbox).toHaveLength(0);
  });
});
