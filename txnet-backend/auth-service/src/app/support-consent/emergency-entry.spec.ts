import { EMERGENCY_ENTRY_PERMISSION, OutboxEventType, runWithTenant } from '@txnet-backend/shared-core';
import { SupportConsentRefused, SupportConsentService } from './support-consent.service';

/**
 * The invariant F-117-d turns on (ADR-0104 (5)): **tier C is entered, never
 * slipped into** — a permission of its own, a reason, one hour from entry and
 * not a minute more, no extension while it runs, and the reseller told at
 * entry. The entry, its audit row and the owner's notice are one transaction:
 * the notice is an outbox row, so delivering it can fail without unrecording
 * the entry.
 */
describe('emergency entry', () => {
  const reseller = 'aaaaaaaa-0000-4000-8000-000000000001';
  const now = new Date('2026-10-04T10:00:00Z');
  const hour = 3600_000;
  const staff = { userId: 'staff-1', tenantId: 'platform', permissions: ['tenant.manage', EMERGENCY_ENTRY_PERMISSION] };
  const owner = { userId: 'owner-1', tenantId: 'platform', permissions: [] as string[] };
  const reason = 'abuse report 4411: phishing links sent from this reseller';

  type Row = Record<string, unknown> & { id: string };

  const build = (as: 'owner' | 'staff' = 'staff', entries: Row[] = []) => {
    const order: string[] = [];
    const audits: Record<string, unknown>[] = [];
    const outbox: Record<string, unknown>[] = [];
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      tenant: { findUnique: vi.fn(async () => ({ ownerUserId: 'owner-1' })) },
      emergencyAccessEntry: {
        findFirst: vi.fn(async ({ where }: { where: { tenantId: string; userId?: string; id?: string; endedAt: null; expiresAt?: { gt: Date } } }) =>
          entries.find(
            (e) =>
              e.tenantId === where.tenantId &&
              (where.userId === undefined || e.userId === where.userId) &&
              (where.id === undefined || e.id === where.id) &&
              e.endedAt === null &&
              (!where.expiresAt || (e.expiresAt as Date) > where.expiresAt.gt),
          ) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          order.push('entry');
          const row = { id: `e-${entries.length + 1}`, endedAt: null, endedByUserId: null, ...data } as Row;
          entries.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          order.push('end');
          return Object.assign(entries.find((e) => e.id === where.id)!, data);
        }),
      },
      adminAuditLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          order.push('audit');
          audits.push(data);
        }),
      },
      outboxEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          order.push('notice');
          outbox.push(data);
          return { id: 'o-1' };
        }),
      },
    };
    const prisma = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const access = {
      run: vi.fn(async (_a: unknown, _t: unknown, _c: string, work: (r: unknown) => Promise<unknown>) =>
        runWithTenant({ id: reseller }, () => work({ id: reseller, slug: 'shop', as })),
      ),
    };
    return { service: new SupportConsentService(prisma as never, access as never), entries, audits, outbox, order };
  };

  it('opens for one hour exactly, recorded and told to the owner in one transaction', async () => {
    const { service, entries, audits, outbox, order } = build();
    const view = await service.enterEmergency(staff, reseller, { reason }, '203.0.113.7', now);

    expect(view).toMatchObject({ userId: 'staff-1', reason, startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + hour).toISOString(), state: 'live' });
    expect(entries[0]).toMatchObject({ tenantId: reseller, userId: 'staff-1', reason, startedAt: now, expiresAt: new Date(now.getTime() + hour) });
    expect(order).toEqual(['entry', 'audit', 'notice']);
    expect(audits[0]).toMatchObject({ tenantId: reseller, adminId: 'staff-1', action: 'emergency_entry_open', targetEntityType: 'emergency_entry', reason });
    expect(outbox[0]).toMatchObject({
      type: OutboxEventType.TENANT_EMERGENCY_ENTRY,
      aggregateId: reseller,
      payload: { tenantId: reseller, ownerUserId: 'owner-1', expiresAt: new Date(now.getTime() + hour).toISOString() },
    });
    // The staff member's words are recorded, not broadcast.
    expect(JSON.stringify(outbox[0])).not.toContain('phishing');
  });

  it('refuses without the permission of its own, or to anyone but the platform — and writes nothing', async () => {
    const plain = build();
    await expect(plain.service.enterEmergency({ ...staff, permissions: ['tenant.manage'] }, reseller, { reason }, '1.1.1.1', now)).rejects.toEqual(
      new SupportConsentRefused('emergency_not_permitted'),
    );
    const theirs = build('owner');
    await expect(theirs.service.enterEmergency(owner, reseller, { reason }, '1.1.1.1', now)).rejects.toEqual(new SupportConsentRefused('only_platform_requests'));
    expect([...plain.order, ...theirs.order]).toEqual([]);
  });

  it('is never extended: a second entry while one runs is refused; once it ends, a new one is a new entry', async () => {
    const running = { id: 'e-0', tenantId: reseller, userId: 'staff-1', startedAt: now, expiresAt: new Date(now.getTime() + hour / 2), endedAt: null };
    const { service, order } = build('staff', [running]);
    await expect(service.enterEmergency(staff, reseller, { reason }, '1.1.1.1', now)).rejects.toEqual(new SupportConsentRefused('emergency_live'));
    expect(order).toEqual([]);

    const later = new Date(now.getTime() + hour);
    await expect(service.enterEmergency(staff, reseller, { reason }, '1.1.1.1', later)).resolves.toMatchObject({ state: 'live' });
  });

  it('its entrant may end it early; nobody else can', async () => {
    const running = { id: 'e-0', tenantId: reseller, userId: 'staff-1', startedAt: now, expiresAt: new Date(now.getTime() + hour), endedAt: null };
    const other = { ...staff, userId: 'staff-2' };
    const { service, audits } = build('staff', [running]);
    await expect(service.endEmergency(other, reseller, 'e-0', '1.1.1.1', now)).rejects.toEqual(new SupportConsentRefused('consent_not_found'));
    await expect(service.endEmergency(staff, reseller, 'e-0', '1.1.1.1', now)).resolves.toMatchObject({ state: 'ended' });
    expect(audits.map((a) => a['action'])).toEqual(['emergency_entry_end']);
  });
});
