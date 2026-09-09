import { Reflector } from '@nestjs/core';
import { Logger, NotFoundException } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import { surfaceServesPath } from './tenant';
import { fakeExecutionContext } from '../../test-support/execution-context';

/**
 * A `purpose = subscription` domain resolves the tenant and serves no panel
 * route (F-066-q, catalog 20.3 / F-1212).
 *
 * The thing that would break silently is the *source* of the restriction. It
 * is the surface — the `tenant_domain` row the host matched — and never `via`:
 * a tenant-A session presented on tenant-A's own subscription domain resolves
 * perfectly well through the `session` entry of the chain, and is exactly the
 * request this row exists to refuse. Reading `via` instead would let every
 * signed-in browser onto the subscription host, which is the whole leak.
 */
describe('a non-panel surface serves no panel route', () => {
  describe('surfaceServesPath', () => {
    it('serves every path on a panel surface', () => {
      expect(surfaceServesPath('panel', '/api/auth/login')).toBe(true);
      expect(surfaceServesPath('panel', '/api/admin/workers')).toBe(true);
    });

    it('serves no auth-service path on a subscription surface', () => {
      // This process has no subscription route to allow: `/sub` belongs to
      // `network`, which has no service yet. An empty allowlist is the honest
      // statement of that, not an unfinished one.
      expect(surfaceServesPath('subscription', '/api/auth/login')).toBe(false);
      expect(surfaceServesPath('subscription', '/api/auth/accounts')).toBe(false);
    });

    it('serves no auth-service path on an assets surface either', () => {
      expect(surfaceServesPath('assets', '/api/auth/login')).toBe(false);
    });
  });

  describe('TenantGuard', () => {
    let guard: TenantGuard;
    let warn: jest.SpyInstance;

    const on = (purpose: string, via: string) => ({
      id: 'tenant-b',
      slug: 'reseller-b',
      via,
      surfacePurpose: purpose,
    });

    beforeEach(() => {
      guard = new TenantGuard({
        getAllAndOverride: () => undefined,
      } as unknown as Reflector);
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => jest.restoreAllMocks());

    it('lets a panel surface through', () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on('panel', 'domain') },
        url: '/api/auth/login',
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('refuses a panel route on a subscription surface', () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on('subscription', 'domain') },
        url: '/api/auth/login',
      });

      expect(() => guard.canActivate(context)).toThrow(NotFoundException);
    });

    it('refuses it just the same when a session resolved the tenant', () => {
      // The restriction is the surface's, not the claim's. A resolved session
      // on its own tenant's subscription domain is the case that reading `via`
      // would wave through.
      const { context } = fakeExecutionContext({
        extra: { tenant: on('subscription', 'session') },
        url: '/api/auth/accounts',
      });

      expect(() => guard.canActivate(context)).toThrow(NotFoundException);
    });

    it('keeps that 404 as neutral as the unknown-host one', () => {
      // Same bare NotFoundException, so `sanitizeError` lands it as the
      // generic `system.notFound`. A subscription domain must not tell a
      // stranger that a panel exists elsewhere (F-1210).
      const { context } = fakeExecutionContext({
        extra: { tenant: on('subscription', 'domain') },
        url: '/api/auth/login',
      });

      try {
        guard.canActivate(context);
        fail('expected a refusal');
      } catch (error) {
        expect((error as NotFoundException).message).toBe('Not Found');
      }
    });

    it('leaves a request with no surface alone', () => {
      // An internal caller reaches `auth-service:3001`, which no
      // `tenant_domain` row names: there is no surface, so there is no
      // purpose to enforce and the claim answers on its own.
      const { context } = fakeExecutionContext({
        extra: { tenant: { id: 'tenant-b', slug: 'reseller-b', via: 'bot' } },
        url: '/api/internal/vault/use',
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('refuses a tenant-agnostic route on a subscription surface', () => {
      // Being tenant-agnostic says the route resolves a tenant rather than
      // requiring one. It is not permission to be served on a door that
      // serves no route of this process at all.
      const agnostic = new TenantGuard({
        getAllAndOverride: () => true,
      } as unknown as Reflector);
      const { context } = fakeExecutionContext({
        extra: { tenant: on('subscription', 'domain') },
        url: '/api/internal/bot-integrations/token',
      });

      expect(() => agnostic.canActivate(context)).toThrow(NotFoundException);
    });
  });
});
