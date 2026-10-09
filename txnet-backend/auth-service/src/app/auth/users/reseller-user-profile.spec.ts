import { Prisma, UserStatus } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';
import { resellerUserProfileSchema } from './reseller-users.schema';
import { ResellerUsersRefused, ResellerUsersService } from './reseller-users.service';

/**
 * The invariant AC-1-a turns on: staff edit a person's name, username and
 * email **only where the authority rule (ADR-0103) lets them act on that
 * person**, and the edit never mints an address nobody proved (identity
 * invariant 15) — an email can be removed here, never written. Every change is
 * one audit row with what it was and what it became; no change writes nothing.
 */
describe('ResellerUsersService — a user\'s profile (AC-1-a)', () => {
  const actor = { userId: 'u-admin', tenantId: 'platform', permissions: ['tenant.manage'] };
  const reseller = 'aaaaaaaa-0000-4000-8000-000000000001';

  const aUser = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'u-1',
    fullName: 'Ali',
    username: 'ali',
    phoneNumber: '+989121234567',
    email: 'ali.rezaei@example.com',
    status: UserStatus.active,
    statusReason: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    role: { id: 'tpl-user', name: 'user', rolePermissions: [] as { permission: { key: string } }[] },
    ...over,
  });

  const build = (options: { user?: unknown; ownerHolds?: boolean; updateThrows?: unknown; as?: 'owner' | 'member' | 'staff' } = {}) => {
    const order: string[] = [];
    const written: { data?: Record<string, unknown>; audit?: Record<string, unknown> } = {};
    const user = {
      findFirst: vi.fn(async () => {
        order.push('findFirst');
        return 'user' in options ? options.user : aUser();
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        order.push('update');
        if (options.updateThrows) throw options.updateThrows;
        written.data = args.data;
        return aUser(args.data);
      }),
    };
    const adminAuditLog = {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        order.push('audit');
        written.audit = args.data;
        return {};
      }),
    };
    const tx = { user, adminAuditLog, $executeRaw: vi.fn(async () => undefined) };
    const prisma = {
      ...tx,
      tenant: { findUnique: vi.fn(async () => ({ ownerUserId: 'u-owner', tenantType: 'reseller' })) },
      $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    };
    const access = {
      runIncludingPlatform: vi.fn(async (_a: unknown, _t: unknown, capability: string, work: (r: unknown) => Promise<unknown>) => {
        order.push(`admit:${capability}`);
        return runWithTenant({ id: reseller }, () => work({ id: reseller, slug: 'vpnshop', as: options.as ?? 'staff' }));
      }),
    };
    const owners = { ownerHoldsUsername: vi.fn(async () => options.ownerHolds ?? false) };
    const service = new ResellerUsersService(prisma as never, access as never, {} as never, owners as never);
    return { service, order, user, adminAuditLog, owners, written };
  };

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'resolved',
      (e: unknown) => (e instanceof ResellerUsersRefused ? e.reason : e),
    );

  it('reads one person under `read`, with the email masked and never the number', async () => {
    const { service, order } = build();

    const profile = await service.profile(actor, reseller, 'u-1');

    expect(order[0]).toBe('admit:read');
    expect(profile).toMatchObject({ id: 'u-1', fullName: 'Ali', phoneMasked: expect.any(String), canAct: true });
    expect(profile.emailMasked).toBe('a***@example.com');
    expect(JSON.stringify(profile)).not.toContain('ali.rezaei');
    expect(JSON.stringify(profile)).not.toContain('9121234567');
  });

  it('writes the changed fields under `staffWrite` and audits them before and after, to the reseller', async () => {
    const { service, order, written } = build();

    const profile = await service.editProfile(actor, reseller, 'u-1', '10.0.0.1', { fullName: 'Ali Rezaei', username: 'ali' });

    expect(order).toEqual(['admit:staffWrite', 'findFirst', 'update', 'audit']);
    // `username` was sent unchanged, so it is neither written nor audited.
    expect(written.data).toEqual({ fullName: 'Ali Rezaei' });
    expect(written.audit).toMatchObject({
      tenantId: reseller,
      adminId: 'u-admin',
      action: 'user_profile_update',
      targetEntityId: 'u-1',
      oldValue: { fullName: 'Ali' },
      newValue: { fullName: 'Ali Rezaei' },
      adminIpAddress: '10.0.0.1',
    });
    expect(profile.fullName).toBe('Ali Rezaei');
  });

  it('removes an email together with its proof, and audits the address masked', async () => {
    const { service, written } = build();

    const profile = await service.editProfile(actor, reseller, 'u-1', '10.0.0.1', { email: null });

    expect(written.data).toEqual({ email: null, emailVerifiedAt: null });
    expect(written.audit).toMatchObject({ oldValue: { email: 'a***@example.com' }, newValue: { email: null } });
    expect(profile.emailMasked).toBeNull();
  });

  it('cannot write an address — only remove one (identity invariant 15)', () => {
    expect(resellerUserProfileSchema.safeParse({ email: 'new@example.com' }).success).toBe(false);
    expect(resellerUserProfileSchema.safeParse({ email: null }).success).toBe(true);
    // The phone is the person's sign-in, never staff's to change.
    expect(resellerUserProfileSchema.safeParse({ phoneNumber: '+989120000000' }).success).toBe(false);
    expect(resellerUserProfileSchema.safeParse({}).success).toBe(false);
  });

  it('a body that changes nothing writes nothing — no update, no audit row', async () => {
    const { service, order } = build();

    await service.editProfile(actor, reseller, 'u-1', '10.0.0.1', { fullName: 'Ali' });

    expect(order).toEqual(['admit:staffWrite', 'findFirst']);
  });

  it('asks the authority rule about the one person: the owner, a peer not below, yourself — refused, nothing written', async () => {
    const owner = build({ user: aUser({ id: 'u-owner' }) });
    expect(await refusal(owner.service.editProfile(actor, reseller, 'u-owner', 'ip', { fullName: 'X Y' }))).toBe('no_authority');
    expect(owner.user.update).not.toHaveBeenCalled();

    const peer = build({
      as: 'member',
      user: aUser({ role: { id: 'r', name: 'admin', rolePermissions: [{ permission: { key: 'tenant.manage' } }] } }),
    });
    expect(await refusal(peer.service.editProfile(actor, reseller, 'u-1', 'ip', { fullName: 'X Y' }))).toBe('no_authority');
    expect(peer.adminAuditLog.create).not.toHaveBeenCalled();

    const self = build({ user: aUser({ id: 'u-admin' }) });
    expect(await refusal(self.service.editProfile(actor, reseller, 'u-admin', 'ip', { fullName: 'X Y' }))).toBe('no_authority');
  });

  it('a user of another tenant is not found; a banned one is the platform\'s and left alone', async () => {
    expect(await refusal(build({ user: null }).service.editProfile(actor, reseller, 'u-9', 'ip', { fullName: 'X Y' }))).toBe('user_not_found');
    const banned = build({ user: aUser({ status: UserStatus.banned }) });
    expect(await refusal(banned.service.editProfile(actor, reseller, 'u-1', 'ip', { fullName: 'X Y' }))).toBe('user_banned');
    expect(banned.user.update).not.toHaveBeenCalled();
  });

  it('a username already held — in the tenant, or by its owner across tenants (invariant 16) — is `username_taken`', async () => {
    const taken = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
    expect(await refusal(build({ updateThrows: taken }).service.editProfile(actor, reseller, 'u-1', 'ip', { username: 'reza' }))).toBe(
      'username_taken',
    );

    const owner = build({ ownerHolds: true });
    expect(await refusal(owner.service.editProfile(actor, reseller, 'u-1', 'ip', { username: 'boss' }))).toBe('username_taken');
    expect(owner.owners.ownerHoldsUsername).toHaveBeenCalledWith('u-owner', reseller, 'boss');
    expect(owner.user.update).not.toHaveBeenCalled();
  });
});
