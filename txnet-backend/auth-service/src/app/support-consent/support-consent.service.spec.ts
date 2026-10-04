import { liveSupportConsent } from '@txnet-backend/shared-core';
import { SupportConsentRefused, SupportConsentService } from './support-consent.service';

/**
 * The invariant this item turns on (ADR-0104 (4), catalog §3.7): **the
 * platform may ask, only the reseller grants** — for at most 24 hours, its own
 * default otherwise — and every boundary (request, grant, revoke) is one
 * `admin_audit_log` row inside the act's transaction, after it.
 *
 * The door is `ResellerAccess`'s (`reseller-access.spec.ts`); what is checked
 * here is who of those it admits may do which verb.
 */
describe('SupportConsentService', () => {
  const reseller = 'aaaaaaaa-0000-4000-8000-000000000001';
  const now = new Date('2026-10-04T10:00:00Z');
  const hour = 3600_000;
  const owner = { userId: 'owner-1', tenantId: 'platform', permissions: [] };
  const staff = { userId: 'staff-1', tenantId: 'platform', permissions: ['tenant.manage'] };

  type Row = Record<string, unknown> & { id: string };

  const build = (opts: { as?: 'owner' | 'member' | 'staff'; rows?: Row[]; policyHours?: number } = {}) => {
    const order: string[] = [];
    const rows: Row[] = [...(opts.rows ?? [])];
    const audits: Record<string, unknown>[] = [];
    const matches = (r: Row, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          const op = v as { not?: unknown; gt?: Date };
          if ('not' in op) return r[k] !== op.not && r[k] !== undefined;
          if (op.gt) return (r[k] as Date) > op.gt;
        }
        return (r[k] ?? null) === v;
      });
    const tx = {
      supportAccessConsent: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          order.push('create');
          const row = { id: `c-${rows.length + 1}`, createdAt: now, ...data } as Row;
          rows.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          order.push('update');
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hit = rows.filter((r) => matches(r, where));
          hit.forEach((r) => Object.assign(r, data));
          if (hit.length) order.push('supersede');
          return { count: hit.length };
        }),
        findMany: vi.fn(async () => rows),
      },
      supportConsentPolicy: {
        findUnique: vi.fn(async () => (opts.policyHours ? { defaultHours: opts.policyHours } : null)),
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
          order.push('policy');
          return create;
        }),
      },
      adminAuditLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          order.push('audit');
          audits.push(data);
        }),
      },
    };
    const prisma = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const access = {
      run: vi.fn(async (_a: unknown, _t: unknown, _c: string, work: (r: unknown) => Promise<unknown>) =>
        work({ id: reseller, slug: 'shop', as: opts.as ?? 'owner' }),
      ),
    };
    const service = new SupportConsentService(prisma as never, access as never);
    return { service, rows, audits, order };
  };

  it('refuses platform staff a grant, and writes nothing', async () => {
    const { service, order } = build({ as: 'staff' });
    await expect(service.grant(staff, reseller, { scope: 'act' }, '1.1.1.1', now)).rejects.toEqual(
      new SupportConsentRefused('platform_cannot_grant'),
    );
    expect(order).toEqual([]);
  });

  it('refuses the reseller a request: only the platform asks', async () => {
    const { service, order } = build({ as: 'owner' });
    await expect(
      service.request(owner, reseller, { scope: 'read', reason: 'user cannot connect' }, '1.1.1.1', now),
    ).rejects.toEqual(new SupportConsentRefused('only_platform_requests'));
    expect(order).toEqual([]);
  });

  it('a staff request is one pending row and its audit row; a second pending one is refused', async () => {
    const { service, rows, order, audits } = build({ as: 'staff' });
    await service.request(staff, reseller, { scope: 'read', reason: 'user cannot connect' }, '1.1.1.1', now);
    expect(order).toEqual(['create', 'audit']);
    expect(rows[0]).toMatchObject({ tenantId: reseller, requestedByUserId: 'staff-1' });
    expect(rows[0].grantedAt).toBeUndefined();
    expect(audits[0]).toMatchObject({ tenantId: reseller, action: 'support_consent_request', targetEntityType: 'support_consent' });
    await expect(
      service.request(staff, reseller, { scope: 'read', reason: 'again' }, '1.1.1.1', now),
    ).rejects.toEqual(new SupportConsentRefused('request_pending'));
  });

  it('a grant lasts the tenant default (4 h with none set) and supersedes a live one, audited after the act', async () => {
    const live = { id: 'old', tenantId: reseller, grantedAt: new Date(now.getTime() - hour), revokedAt: null, expiresAt: new Date(now.getTime() + hour) };
    const { service, rows, order, audits } = build({ rows: [live] });
    const out = await service.grant(owner, reseller, { scope: 'act' }, '1.1.1.1', now);
    expect(out.expiresAt).toBe(new Date(now.getTime() + 4 * hour).toISOString());
    expect(rows.find((r) => r.id === 'old')!.revokedAt).toEqual(now);
    expect(order).toEqual(['supersede', 'create', 'audit']);
    expect(audits[0]).toMatchObject({ action: 'support_consent_grant', adminId: 'owner-1', tenantId: reseller });
  });

  it("uses the tenant's own default, and never more than 24 hours", async () => {
    const { service } = build({ policyHours: 8 });
    const out = await service.grant(owner, reseller, { scope: 'read' }, '1.1.1.1', now);
    expect(out.expiresAt).toBe(new Date(now.getTime() + 8 * hour).toISOString());
    await expect(service.grant(owner, reseller, { scope: 'read', hours: 25 }, '1.1.1.1', now)).rejects.toEqual(
      new SupportConsentRefused('hours_out_of_range'),
    );
  });

  it('granting a request turns that row live with the scope the reseller chose', async () => {
    const pending = { id: 'req', tenantId: reseller, scope: 'act', requestedByUserId: 'staff-1', grantedAt: null, revokedAt: null };
    const { service, rows } = build({ rows: [pending] });
    await service.grant(owner, reseller, { scope: 'read', requestId: 'req', hours: 2 }, '1.1.1.1', now);
    expect(rows[0]).toMatchObject({ scope: 'read', grantedByUserId: 'owner-1', grantedAt: now, expiresAt: new Date(now.getTime() + 2 * hour) });
  });

  it('revoke ends a live consent; an ended one is refused and nothing is written', async () => {
    const live = { id: 'c', tenantId: reseller, grantedAt: now, revokedAt: null, expiresAt: new Date(now.getTime() + hour) };
    const { service, rows, order } = build({ rows: [live] });
    await service.revoke(owner, reseller, 'c', '1.1.1.1', now);
    expect(rows[0].revokedAt).toEqual(now);
    expect(order).toEqual(['update', 'audit']);
    await expect(service.revoke(owner, reseller, 'c', '1.1.1.1', now)).rejects.toEqual(new SupportConsentRefused('consent_not_found'));
  });

  it('liveSupportConsent reads only a granted, unrevoked, unexpired row', async () => {
    const findFirst = vi.fn(async () => null);
    await liveSupportConsent({ supportAccessConsent: { findFirst } } as never, reseller, now);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: reseller, grantedAt: { not: null }, revokedAt: null, expiresAt: { gt: now } },
      }),
    );
  });
});
