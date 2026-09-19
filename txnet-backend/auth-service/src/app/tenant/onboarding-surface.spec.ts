import type { MockInstance } from 'vitest';
import { Reflector } from '@nestjs/core';
import { Logger, NotFoundException } from '@nestjs/common';
import {
  UnscopedRedisKeys,
  serializeTenantStatusState,
  type TenantStatusStore,
} from '@txnet-backend/shared-core';
import { TenantGuard } from './tenant.guard';
import { DoorController } from './door.controller';
import { DOOR_PROBE } from './door';
import { TENANT_AGNOSTIC } from './tenant-agnostic.decorator';
import { fakeExecutionContext } from '../../test-support/execution-context';

/**
 * A gated reseller's platform subdomain serves **nothing, to anyone** — its end
 * users and the reseller itself alike (F-066-x, user 2026-09-19; D-01). The
 * reseller configures from the platform's own panel, where its owner's account
 * already lives (ADR-0059), until a domain of its own is proved.
 *
 * F-018-ag served the reseller's console there and closed only the end user's
 * paths. The user closed the rest: a platform host a reseller can use is a
 * platform host it can hand its customers, and a filter on the platform's name
 * then takes them all down together.
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
 *
 * `GET /api/auth/door` is the panel's half of the same rule (F-066-x): the page
 * is served by another deployable, which asks here before it renders. It must
 * *answer* on the doors it reports closed, so it is the one route those
 * refusals skip.
 */
describe("a gated reseller's platform subdomain serves nothing", () => {
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

  describe('TenantGuard', () => {
    let warn: MockInstance;

    /** A reflector that answers only for the metadata keys it is given. */
    const guardWith = (
      state: Record<string, boolean>,
      marks: { agnostic?: boolean; probe?: boolean } = {},
    ) =>
      new TenantGuard(
        {
          getAllAndOverride: (key: string) =>
            (key === TENANT_AGNOSTIC && marks.agnostic) ||
            (key === DOOR_PROBE && marks.probe) ||
            undefined,
        } as unknown as Reflector,
        store(state),
      );

    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => vi.restoreAllMocks());

    it.each([
      // The console's own door and screens: closed now too (F-066-x).
      ['/api/auth/login/password'],
      ['/api/auth/refresh'],
      ['/api/auth/roles'],
      ['/api/auth/me'],
      // The end user's doors, as before.
      ['/api/auth/register'],
      ['/api/auth/bots/webapp/session'],
      ['/api/auth/handoff'],
    ])("refuses %s on a gated reseller's subdomain", async (url) => {
      const { context } = fakeExecutionContext({ extra: { tenant: on() }, url });

      await expect(guardWith(gated('reseller-b')).canActivate(context)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('keeps that refusal as neutral as the unknown-host one', async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/login/password',
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
        url: '/api/auth/me',
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
      // not a reason to 404 a reseller's door.
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
        guardWith(gated('reseller-b'), { agnostic: true }).canActivate(context),
      ).rejects.toThrow(NotFoundException);
    });

    it('lets the door question through on the door it reports closed', async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/door',
      });

      await expect(
        guardWith(gated('reseller-b'), { probe: true }).canActivate(context),
      ).resolves.toBe(true);
    });

    it('lets it through on a subscription domain too', async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on({ surfacePurpose: 'subscription' }) },
        url: '/api/auth/door',
      });

      await expect(guardWith({}, { probe: true }).canActivate(context)).resolves.toBe(true);
    });

    it('still refuses the door question on a host that resolves to no tenant', async () => {
      // An unregistered host keeps F-066-u's answer — the neutral 404 — and
      // the panel reads that 404 as "nothing to mirror".
      const { context } = fakeExecutionContext({ url: '/api/auth/door' });

      await expect(guardWith({}, { probe: true }).canActivate(context)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /api/auth/door', () => {
    const ask = (tenant: Record<string, unknown>, state: Record<string, boolean> = {}) =>
      new DoorController(store(state)).door({ tenant } as never);

    it("answers closed on a gated reseller's platform subdomain", async () => {
      await expect(ask(on(), gated('reseller-b'))).resolves.toMatchObject({
        ok: true,
        data: { serves: false },
      });
    });

    it('reads the gate of the tenant that owns the host', async () => {
      const owner = on({ id: 'owner-own', brand: { id: 'reseller-b', slug: 'reseller-b' } });
      await expect(ask(owner, gated('reseller-b'))).resolves.toMatchObject({
        data: { serves: false },
      });
    });

    it.each([['subscription'], ['assets']])('answers closed on a %s domain', async (purpose) => {
      await expect(ask(on({ surfacePurpose: purpose }))).resolves.toMatchObject({
        data: { serves: false },
      });
    });

    it('answers open once the reseller is no longer gated', async () => {
      await expect(
        ask(on(), { [UnscopedRedisKeys.tenantStatus('reseller-b')]: false }),
      ).resolves.toMatchObject({ data: { serves: true } });
    });

    it("answers open on a reseller's own custom domain", async () => {
      await expect(
        ask(on({ surfaceDomainType: 'custom_domain' }), gated('reseller-b')),
      ).resolves.toMatchObject({ data: { serves: true } });
    });

    it('answers open when the gate state is missing', async () => {
      await expect(ask(on())).resolves.toMatchObject({ data: { serves: true } });
    });
  });
});
