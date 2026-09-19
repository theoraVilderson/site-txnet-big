import type { MockInstance } from 'vitest';
import { Reflector } from '@nestjs/core';
import { Logger, NotFoundException } from '@nestjs/common';
import {
  UnscopedRedisKeys,
  serializeTenantStatusState,
  type TenantStatusStore,
} from '@txnet-backend/shared-core';
import { TenantGuard } from './tenant.guard';
import { gatedConsoleServesPath } from './tenant';
import { fakeExecutionContext } from '../../test-support/execution-context';

/**
 * A gated reseller's platform subdomain serves its configuration console and
 * nothing an end user would use (F-018-ag, D-01).
 *
 * F-018-l closes `register` / `sell` / `endUserDeposit` / `subscriptionLink`
 * by capability, and deliberately leaves `signIn` / `read` / `account` open —
 * closing those would lock the reseller's own staff out of the one screen that
 * lifts the gate. So the remainder of D-01 is a question about the *door*, and
 * it is answered where F-066-q already answers one: the surface.
 *
 * The two things that would break silently:
 *
 * 1. **Which tenant's gate is read.** It is the tenant that owns the *host*,
 *    not the one the request is scoped to. A reseller owner arriving on their
 *    own gated subdomain with a session scoped to their personal tenant
 *    (ADR-0059) resolves with `brand` set to the reseller, and reading `id`
 *    would leave the door wide open for exactly the account that has one.
 * 2. **The platform's own main domain.** It must never be filtered because a
 *    reseller parked its end users on it (user, 2026-09-19). It is not,
 *    because the platform owner is never onboarding — so this asserts the
 *    filter is off for an un-gated tenant on the same kind of door, which is
 *    the only thing this layer can assert.
 */
describe("a gated reseller's platform subdomain serves only its console", () => {
  describe('gatedConsoleServesPath', () => {
    it("serves the console's own door", () => {
      // Sign-in stays open: the gate is left by configuring, and the staff
      // have to get in to configure. This is the case a capability could not
      // express, which is why the rule is a path one.
      expect(gatedConsoleServesPath('/api/auth/login/password')).toBe(true);
      expect(gatedConsoleServesPath('/api/auth/refresh')).toBe(true);
      expect(gatedConsoleServesPath('/api/auth/captcha/challenge')).toBe(true);
      expect(gatedConsoleServesPath('/api/auth/password/forgot')).toBe(true);
    });

    it("serves the console's own screens", () => {
      expect(gatedConsoleServesPath('/api/auth/roles')).toBe(true);
      expect(gatedConsoleServesPath('/api/auth/users')).toBe(true);
      expect(gatedConsoleServesPath('/api/auth/workers/dead-letters')).toBe(true);
      expect(gatedConsoleServesPath('/api/auth/me')).toBe(true);
    });

    it('serves no end-user door', () => {
      // A bot-link session minted on the platform's own subdomain is D-01
      // happening, spelled in full: an end user served a platform host.
      expect(gatedConsoleServesPath('/api/auth/bots/link/resolve')).toBe(false);
      expect(gatedConsoleServesPath('/api/auth/bots/session')).toBe(false);
      expect(gatedConsoleServesPath('/api/auth/bots/webapp/session')).toBe(false);
      expect(gatedConsoleServesPath('/api/auth/handoff')).toBe(false);
    });

    it("still serves the console's own route under the same prefix", () => {
      // `/api/auth/bots` is both: the console rotates a webhook secret there
      // and an end user signs in there. The narrower deny list is what keeps
      // one from closing the other.
      expect(
        gatedConsoleServesPath('/api/auth/bots/telegram/shopbot/webhook/rotate'),
      ).toBe(true);
    });

    it('closes a path it has never heard of', () => {
      // Deny by default, and that is the side to fail on: a route added next
      // year is closed on a gated reseller's platform host — the narrowest
      // blast radius there is — until someone classifies it.
      expect(gatedConsoleServesPath('/api/auth/something-new')).toBe(false);
      expect(gatedConsoleServesPath('/api/internal/otp/deliver')).toBe(false);
    });

    it('never matches a longer sibling of an allowed prefix', () => {
      expect(gatedConsoleServesPath('/api/auth/sessions-of-everyone')).toBe(false);
      expect(gatedConsoleServesPath('/api/auth/registered-users')).toBe(false);
    });

    it('closes registration here too, as a 404 rather than the 403', () => {
      // F-018-l already refuses it by capability. On a platform host the
      // neutral 404 is the better answer: a stranger is not told that a
      // reseller lives at this address at all (F-1210).
      expect(gatedConsoleServesPath('/api/auth/register')).toBe(false);
    });
  });

  describe('TenantGuard', () => {
    let warn: MockInstance;

    const store = (state: Record<string, boolean>): TenantStatusStore => ({
      get: (key: string) =>
        Promise.resolve(
          key in state
            ? serializeTenantStatusState({
                status: 'trial',
                graceEndsAt: null,
                onboarding: state[key],
              })
            : null,
        ),
    });

    const guardWith = (state: Record<string, boolean>, agnostic = false) =>
      new TenantGuard(
        { getAllAndOverride: () => (agnostic ? true : undefined) } as unknown as Reflector,
        store(state),
      );

    const gated = (tenantId: string) => ({
      [UnscopedRedisKeys.tenantStatus(tenantId)]: true,
    });

    const on = (extra: Record<string, unknown> = {}) => ({
      id: 'reseller-b',
      slug: 'reseller-b',
      via: 'domain',
      surfacePurpose: 'panel',
      surfaceDomainType: 'subdomain',
      ...extra,
    });

    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => vi.restoreAllMocks());

    it("serves the console on a gated reseller's subdomain", async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/login/password',
      });

      await expect(guardWith(gated('reseller-b')).canActivate(context)).resolves.toBe(true);
    });

    it('refuses an end-user door on it', async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/bots/webapp/session',
      });

      await expect(guardWith(gated('reseller-b')).canActivate(context)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('keeps that refusal as neutral as the unknown-host one', async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/bots/webapp/session',
      });

      await expect(
        guardWith(gated('reseller-b')).canActivate(context),
      ).rejects.toMatchObject({ message: 'Not Found' });
    });

    it('reads the gate of the tenant that owns the host, not the scoped one', async () => {
      // ADR-0059: the reseller's owner, on the reseller's subdomain, with a
      // session scoped to their own (un-gated) tenant. The door is still the
      // reseller's, so the reseller's gate decides.
      const { context } = fakeExecutionContext({
        extra: { tenant: on({ id: 'owner-own', brand: { id: 'reseller-b', slug: 'reseller-b' } }) },
        url: '/api/auth/bots/link/resolve',
      });

      await expect(guardWith(gated('reseller-b')).canActivate(context)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('leaves an un-gated tenant on the same kind of door unfiltered', async () => {
      // The platform owner's own main domain is this case: it is never
      // onboarding, so nothing about it is filtered (user, 2026-09-19).
      const { context } = fakeExecutionContext({
        extra: { tenant: on({ id: 'platform', slug: 'platform' }) },
        url: '/api/auth/bots/webapp/session',
      });

      await expect(
        guardWith({
          [UnscopedRedisKeys.tenantStatus('platform')]: false,
        }).canActivate(context),
      ).resolves.toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not filter a reseller's own proved custom domain", async () => {
      // A `custom_domain` is the reseller's shop, not a platform host, so D-01
      // has nothing to say about it — and a reseller holding a verified panel
      // domain is not gated anyway.
      const { context } = fakeExecutionContext({
        extra: { tenant: on({ surfaceDomainType: 'custom_domain' }) },
        url: '/api/auth/bots/webapp/session',
      });

      await expect(guardWith(gated('reseller-b')).canActivate(context)).resolves.toBe(true);
    });

    it('reads no state at all when there is no surface', async () => {
      // An internal caller on a container name: no door, nothing to filter,
      // and no Redis read to pay for it.
      const get = vi.fn();
      const guard = new TenantGuard(
        { getAllAndOverride: () => undefined } as unknown as Reflector,
        { get } as unknown as TenantStatusStore,
      );
      const { context } = fakeExecutionContext({
        extra: { tenant: { id: 'reseller-b', slug: 'reseller-b', via: 'bot' } },
        url: '/api/internal/otp/deliver',
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(get).not.toHaveBeenCalled();
    });

    it('filters nothing when the state is missing or unreadable', async () => {
      // The same trade `TenantStatusGuard` makes: the listener recomputes
      // every tenant on each connect, so a missing key is a boot window and
      // not a reason to 404 a reseller's console.
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/bots/webapp/session',
      });

      await expect(guardWith({}).canActivate(context)).resolves.toBe(true);
    });

    it('refuses a tenant-agnostic route on a gated subdomain', async () => {
      // As with the purpose check: being tenant-agnostic says the route
      // resolves a tenant, not that it may be served on a closed door.
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/register',
      });

      await expect(
        guardWith(gated('reseller-b'), true).canActivate(context),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
