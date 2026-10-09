import { ForbiddenException } from '@nestjs/common';
import { runWithTenant, SupportConsentRefused } from '@txnet-backend/shared-core';

import { ImpersonationLeash } from './impersonation-leash';
import { ImpersonationService } from './impersonation.service';
import { accessOf } from '../auth/permissions/access';

/** Nobody here has access beyond their role (ADR-0138). */
const ROLE_ONLY = { ofLoaded: async (u: any) => accessOf({ roleKeys: u.role?.rolePermissions?.map((rp: any) => rp.permission.key) ?? [] }) } as never;

/**
 * The invariant F-117-e turns on (ADR-0104 (4)(5), catalog §3.6 layer 6):
 * **the platform's staff become a reseller's user only while the reseller's
 * `act` consent — or their own emergency entry — runs, and not one request
 * longer.** The door decides admission; the session is minted to end no later
 * than what admitted it, is tied to it, and a revoke or an early end kills it at
 * once rather than at its 30 minutes.
 */
describe("impersonating a reseller's user", () => {
  const RESELLER = 'aaaaaaaa-0000-4000-8000-000000000001';
  const STAFF = 'staff-1';
  const TARGET = 'user-9';
  const REASON = 'customer reports a failed top-up, ticket 4417';
  const now = new Date('2026-10-04T10:00:00Z');
  const actor = { userId: STAFF, tenantId: 'platform', permissions: ['platform.tenant.manage', 'user.impersonate'] };

  const build = (
    support: { tier: 'consent' | 'emergency'; consentId?: string; entryId?: string; endsAt: Date } | Error,
    owner = 'reseller-owner',
  ) => {
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      impersonationSession: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'imp-1', ...data })) },
      adminAuditLog: { create: vi.fn(async () => ({})) },
    };
    const users: Record<string, unknown> = {
      [STAFF]: { id: STAFF, roleId: 'r-super', role: { name: 'SuperAdmin', rolePermissions: [{ permission: { key: '*' } }] } },
      [TARGET]: { id: TARGET, roleId: 'r-user', status: 'active', role: { name: 'User', rolePermissions: [] } },
    };
    const prisma = {
      user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id] ?? null) },
      // The reseller, whose owner is someone else unless a test says so (ADR-0137).
      tenant: { findUnique: vi.fn(async () => ({ ownerUserId: owner, tenantType: 'reseller' })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const sessionService = {
      createSession: vi.fn(async () => ({ session: { id: 'session-imp' }, refreshToken: 'r', activateCache: vi.fn(async () => undefined) })),
    };
    const tokens = { signImpersonatedToken: vi.fn(() => 'impersonated-token') };
    const access = {
      for() {
        return this;
      },
      asStaff() {
        return this;
      },
      runIncludingPlatform: vi.fn(async (_a: unknown, _t: string, capability: string, work: (r: unknown) => Promise<unknown>) => {
        if (support instanceof Error) throw support;
        expect(capability).toBe('staffWrite');
        return runWithTenant({ id: RESELLER }, () => work({ id: RESELLER, slug: 'shop', as: 'staff', support }));
      }),
    };
    const service = new ImpersonationService(prisma as never, tokens as never, sessionService as never, {} as never, access as never, ROLE_ONLY);
    return { service, tx, sessionService };
  };

  it('needs the door: no act consent and no entry, no session and nothing written', async () => {
    const { service, tx, sessionService } = build(new SupportConsentRefused('consent_read_only'));
    await expect(service.startForReseller(actor, RESELLER, TARGET, REASON, '1.1.1.1', 'ua', now)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessionService.createSession).not.toHaveBeenCalled();
    expect(tx.impersonationSession.create).not.toHaveBeenCalled();
  });

  it("ends no later than the consent that admitted it, is tied to it, and is audited in the reseller's own log", async () => {
    const { service, tx, sessionService } = build({ tier: 'consent', consentId: 'consent-1', endsAt: new Date(now.getTime() + 10 * 60_000) });
    const out = await service.startForReseller(actor, RESELLER, TARGET, REASON, '1.1.1.1', 'ua', now);

    expect(out).toEqual({ accessToken: 'impersonated-token', expiresIn: 600 });
    expect(sessionService.createSession).toHaveBeenCalledWith(TARGET, '1.1.1.1', 'ua', expect.objectContaining({ isImpersonated: true, expiresInSec: 600 }));
    expect(tx.impersonationSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ adminId: STAFF, targetUserId: TARGET, consentId: 'consent-1', emergencyEntryId: null }),
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: RESELLER, adminId: STAFF, action: 'user_impersonate_start', targetEntityId: TARGET }),
    });
  });

  it('keeps the 30 minute cap when the consent runs longer, and ties an emergency session to its entry', async () => {
    const { service, tx, sessionService } = build({ tier: 'emergency', entryId: 'entry-1', endsAt: new Date(now.getTime() + 50 * 60_000) });
    await service.startForReseller(actor, RESELLER, TARGET, REASON, '1.1.1.1', 'ua', now);
    expect(sessionService.createSession).toHaveBeenCalledWith(TARGET, '1.1.1.1', 'ua', expect.objectContaining({ expiresInSec: 1800 }));
    expect(tx.impersonationSession.create).toHaveBeenCalledWith({ data: expect.objectContaining({ consentId: null, emergencyEntryId: 'entry-1' }) });
  });

  // ADR-0137: the account that holds a tenant is never impersonated — not under
  // an `act` consent, not under an emergency entry. Support reaches the owner's
  // tenant through tier B in its own name instead.
  it.each([
    ['an act consent', { tier: 'consent' as const, consentId: 'consent-1', endsAt: new Date(now.getTime() + 60 * 60_000) }],
    ['an emergency entry', { tier: 'emergency' as const, entryId: 'entry-1', endsAt: new Date(now.getTime() + 60 * 60_000) }],
  ])("never becomes the reseller's owner, even under %s", async (_label, support) => {
    const { service, tx, sessionService } = build(support, TARGET);
    await expect(service.startForReseller(actor, RESELLER, TARGET, REASON, '1.1.1.1', 'ua', now)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessionService.createSession).not.toHaveBeenCalled();
    expect(tx.impersonationSession.create).not.toHaveBeenCalled();
  });

  it('a revoked consent or an ended entry kills its running sessions at once', async () => {
    const running = [{ id: 'imp-1' }, { id: 'imp-2' }];
    const live = [
      { id: 's-1', userId: TARGET },
      { id: 's-2', userId: 'user-8' },
    ];
    const prisma = {
      impersonationSession: {
        findMany: vi.fn(async () => running),
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
      session: {
        findMany: vi.fn(async () => live),
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
    };
    const sessions = { drop: vi.fn(async () => undefined) };
    const leash = new ImpersonationLeash(prisma as never, sessions as never);

    await expect(leash.endUnder({ consentIds: ['consent-1'] }, now)).resolves.toBe(2);
    expect(prisma.impersonationSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { endedAt: null, OR: [{ consentId: { in: ['consent-1'] } }] } }),
    );
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { impersonationSessionId: { in: ['imp-1', 'imp-2'] }, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'impersonation_ended' },
    });
    expect(sessions.drop.mock.calls).toEqual([
      ['s-1', TARGET],
      ['s-2', 'user-8'],
    ]);
  });
});
