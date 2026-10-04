import { TenantContext } from '@txnet-backend/shared-core';

import { ConversationRefused } from '../conversations/refusal';
import { PlatformSupportDoor } from './platform-door';

/**
 * The invariant this item turns on (catalog §11.6, ADR-0104 (4)): **platform
 * staff reach a reseller's support only under that reseller's live consent** —
 * `read` sees, `act` also writes — and the work then runs as the reseller's
 * tenant, never the platform's. Read on every request: a revoke ends it on the
 * next one.
 */
describe('PlatformSupportDoor', () => {
  const PLATFORM = 'pppppppp-0000-4000-8000-000000000001';
  const RESELLER = 'rrrrrrrr-0000-4000-8000-000000000001';
  const now = new Date('2026-10-04T10:00:00Z');
  const staff = { userId: 'staff-1', tenantId: PLATFORM, permissions: ['support.agent'] };

  const build = (opts: { consent?: { scope: 'read' | 'act' } | null; resellerStatus?: string; callerType?: string } = {}) => {
    const consentRead = vi.fn(async () =>
      opts.consent === null || opts.consent === undefined
        ? null
        : { id: 'c-1', scope: opts.consent.scope, expiresAt: new Date(now.getTime() + 3600_000) },
    );
    const prisma = {
      tenant: {
        findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })),
        findFirst: vi.fn(async () =>
          opts.resellerStatus === 'missing' ? null : { id: RESELLER, status: opts.resellerStatus ?? 'active' },
        ),
      },
    };
    const bound: unknown[] = [];
    const tx = {
      $executeRaw: vi.fn(async (_s: unknown, tenantId: unknown) => {
        bound.push(tenantId);
      }),
      supportAccessConsent: { findFirst: consentRead },
    };
    Object.assign(prisma, { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) });
    return { door: new PlatformSupportDoor(prisma as never), consentRead, bound };
  };

  const refusal = (reason: string) => new ConversationRefused(reason as never);

  it("refuses a caller outside the platform's tenant before reading any consent", async () => {
    const { door, consentRead } = build({ callerType: 'reseller', consent: { scope: 'act' } });
    await expect(door.run(staff, RESELLER, 'read', async () => 'x', now)).rejects.toEqual(refusal('not_platform_staff'));
    expect(consentRead).not.toHaveBeenCalled();
  });

  it('refuses a caller without support.agent', async () => {
    const { door } = build({ consent: { scope: 'act' } });
    await expect(door.run({ ...staff, permissions: ['tenant.manage'] }, RESELLER, 'read', async () => 'x', now)).rejects.toEqual(
      refusal('not_platform_staff'),
    );
  });

  it('a missing or terminated reseller is one answer', async () => {
    for (const resellerStatus of ['missing', 'terminated']) {
      const { door } = build({ resellerStatus, consent: { scope: 'act' } });
      await expect(door.run(staff, RESELLER, 'read', async () => 'x', now)).rejects.toEqual(refusal('reseller_not_found'));
    }
  });

  it('without a live consent nothing runs', async () => {
    const { door } = build({ consent: null });
    const work = vi.fn(async () => 'x');
    await expect(door.run(staff, RESELLER, 'read', work, now)).rejects.toEqual(refusal('consent_required'));
    expect(work).not.toHaveBeenCalled();
  });

  it('a read consent reads, and refuses a write', async () => {
    const { door } = build({ consent: { scope: 'read' } });
    await expect(door.run(staff, RESELLER, 'read', async () => 'seen', now)).resolves.toBe('seen');
    await expect(door.run(staff, RESELLER, 'act', async () => 'wrote', now)).rejects.toEqual(refusal('consent_read_only'));
  });

  it("an act consent runs the work as the reseller's tenant, with the staff member as the agent", async () => {
    const { door, consentRead, bound } = build({ consent: { scope: 'act' } });
    const seen = await door.run(staff, RESELLER, 'act', async (caller) => ({ caller, scope: TenantContext.current().id }), now);
    expect(seen).toEqual({ caller: { tenantId: RESELLER, userId: 'staff-1' }, scope: RESELLER });
    // The consent is read in a transaction bound to the reseller (RLS), not a bare query.
    expect(bound).toEqual([RESELLER]);
    expect(consentRead).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: RESELLER, expiresAt: { gt: now } }) }),
    );
  });
});
