import { Reflector } from '@nestjs/core';
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import { TenantClaimConflict } from './tenant';
import { fakeExecutionContext } from '../../test-support/execution-context';

/**
 * The two refusals ADR-0024 decision 4 and ADR-0025 ask for, tested where they
 * are actually observable. `TenantResolverService` decides that a request has
 * no tenant or that two tenants disagree; this guard is the only thing that
 * turns either into a response, and it is global — so what is worth asserting
 * is that each refusal fires whatever route the request was heading for, and
 * that neither says more than it should.
 */
describe('TenantGuard', () => {
  let guard: TenantGuard;
  let warn: jest.SpyInstance;

  const resolved = { id: 'tenant-b', slug: 'reseller-b', via: 'domain' as const };

  const conflict = new TenantClaimConflict('tenant-a', {
    id: 'tenant-b',
    slug: 'reseller-b',
    via: 'domain',
  });

  beforeEach(() => {
    // A reflector that finds no metadata: the routes under test carry no
    // `@TenantAgnostic`, which is the case every assertion here is about.
    guard = new TenantGuard({
      getAllAndOverride: () => undefined,
    } as unknown as Reflector);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('lets a resolved request with no conflict through', () => {
    const { context } = fakeExecutionContext({ extra: { tenant: resolved } });

    expect(guard.canActivate(context)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a request that resolved to no tenant at all', () => {
    // There is no fallback tenant any more (ADR-0025): an unknown or
    // unverified host is nothing at this address, not the platform owner.
    const { context } = fakeExecutionContext({ extra: { tenant: null } });

    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
  });

  it('keeps that 404 neutral — no i18n key, nothing about tenancy', () => {
    // `sanitizeError` only forwards a message that looks like an i18n key, so
    // a bare NotFoundException lands as the same `system.notFound` an
    // unmatched route produces. That is what stops a stranger learning the
    // platform exists (F-1210).
    const { context } = fakeExecutionContext({
      extra: { tenant: null },
      url: '/api/auth/login',
    });

    try {
      guard.canActivate(context);
      fail('expected a refusal');
    } catch (error) {
      expect((error as NotFoundException).message).toBe('Not Found');
    }
  });

  it('answers a conflict as 403, not as the 404 an unresolved host gets', () => {
    // A refused claim leaves no tenant on the request, so the order of the two
    // checks is what keeps this case distinguishable at all.
    const { context } = fakeExecutionContext({
      extra: { tenant: null, tenantConflict: conflict },
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('refuses a request whose claim and surface disagree', () => {
    const { context } = fakeExecutionContext({
      extra: { tenant: resolved, tenantConflict: conflict },
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('answers an i18n key, never the tenants involved', () => {
    // The client is told the session does not belong here and nothing else:
    // naming the other tenant would tell an unknown host what the platform
    // knows (ADR-0025).
    const { context } = fakeExecutionContext({
      extra: { tenant: resolved, tenantConflict: conflict },
    });

    try {
      guard.canActivate(context);
      fail('expected a refusal');
    } catch (error) {
      expect((error as ForbiddenException).message).toBe('tenant.claimMismatch');
    }
    // Both tenant ids are in the log line, and only there.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tenant-a'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tenant-b'));
  });
});
