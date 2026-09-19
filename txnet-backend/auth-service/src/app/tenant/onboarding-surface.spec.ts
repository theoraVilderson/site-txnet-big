import type { MockInstance } from 'vitest';
import { Reflector } from '@nestjs/core';
import { Logger, NotFoundException } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import { DoorController } from './door.controller';
import { DOOR_PROBE } from './door';
import { TENANT_AGNOSTIC } from './tenant-agnostic.decorator';
import { fakeExecutionContext } from '../../test-support/execution-context';

/**
 * **A reseller's platform subdomain serves nothing, to anyone** (ADR-0063,
 * F-066-x, D-01). Its only one is its CNAME target `<slug>.edge.<domain>`,
 * which connects the reseller's own domain and is never a door; a
 * `<slug>.<domain>` row from before ADR-0063 is closed the same way, so one
 * that outlives its deletion in the cache is harmless.
 *
 * It is a fact about the host's owner, not about the reseller's gate: the
 * resolver says who issued the surface (`surfaceTenantType`), and no status is
 * read. The platform owner's own subdomains (`panel.<domain>`) serve as ever.
 *
 * `GET /api/auth/door` is the panel's half of the same rule (F-066-x): the page
 * is served by another deployable, which asks here before it renders. It must
 * *answer* on the doors it reports closed, so it is the one route the surface
 * refusals skip.
 */
describe("a reseller's platform subdomain serves nothing", () => {
  const on = (extra: Record<string, unknown> = {}) => ({
    id: 'reseller-b',
    slug: 'reseller-b',
    via: 'domain',
    surfacePurpose: 'panel',
    surfaceDomainType: 'subdomain',
    surfaceTenantType: 'reseller',
    ...extra,
  });
  const platform = on({ id: 'platform', slug: 'platform', surfaceTenantType: 'platform_owner' });

  describe('TenantGuard', () => {
    let warn: MockInstance;

    /** A reflector that answers only for the metadata keys it is given. */
    const guardWith = (marks: { agnostic?: boolean; probe?: boolean } = {}) =>
      new TenantGuard({
        getAllAndOverride: (key: string) =>
          (key === TENANT_AGNOSTIC && marks.agnostic) ||
          (key === DOOR_PROBE && marks.probe) ||
          undefined,
      } as unknown as Reflector);

    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => vi.restoreAllMocks());

    it.each([
      ['/api/auth/login/password'],
      ['/api/auth/refresh'],
      ['/api/auth/roles'],
      ['/api/auth/me'],
      ['/api/auth/register'],
      ['/api/auth/bots/webapp/session'],
      ['/api/auth/handoff'],
    ])("refuses %s on a reseller's platform subdomain", async (url) => {
      const { context } = fakeExecutionContext({ extra: { tenant: on() }, url });

      await expect(guardWith().canActivate(context)).rejects.toThrow(NotFoundException);
    });

    it('keeps that refusal as neutral as the unknown-host one', async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/login/password',
      });

      await expect(guardWith().canActivate(context)).rejects.toMatchObject({
        message: 'Not Found',
      });
    });

    it("judges the host's owner, not the scoped tenant", async () => {
      // ADR-0059: the reseller's owner, on the reseller's host, with a session
      // scoped to their own tenant. The door is still the reseller's.
      const { context } = fakeExecutionContext({
        extra: { tenant: on({ id: 'owner-own', brand: { id: 'reseller-b', slug: 'reseller-b' } }) },
        url: '/api/auth/me',
      });

      await expect(guardWith().canActivate(context)).rejects.toThrow(NotFoundException);
    });

    it("leaves the platform owner's own subdomain unfiltered", async () => {
      // `panel.<domain>` is a subdomain too — the platform's.
      const { context } = fakeExecutionContext({
        extra: { tenant: platform },
        url: '/api/auth/bots/webapp/session',
      });

      await expect(guardWith().canActivate(context)).resolves.toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not filter a reseller's own proved custom domain", async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on({ surfaceDomainType: 'custom_domain' }) },
        url: '/api/auth/bots/webapp/session',
      });

      await expect(guardWith().canActivate(context)).resolves.toBe(true);
    });

    it('filters nothing when there is no surface', async () => {
      // An internal caller on a container name: no door, nothing to judge.
      const { context } = fakeExecutionContext({
        extra: { tenant: { id: 'reseller-b', slug: 'reseller-b', via: 'bot' } },
        url: '/api/internal/otp/deliver',
      });

      await expect(guardWith().canActivate(context)).resolves.toBe(true);
    });

    it('refuses a tenant-agnostic route there too', async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on() },
        url: '/api/auth/register',
      });

      await expect(guardWith({ agnostic: true }).canActivate(context)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lets the door question through on the door it reports closed', async () => {
      const { context } = fakeExecutionContext({ extra: { tenant: on() }, url: '/api/auth/door' });

      await expect(guardWith({ probe: true }).canActivate(context)).resolves.toBe(true);
    });

    it('lets it through on a subscription domain too', async () => {
      const { context } = fakeExecutionContext({
        extra: { tenant: on({ surfacePurpose: 'subscription' }) },
        url: '/api/auth/door',
      });

      await expect(guardWith({ probe: true }).canActivate(context)).resolves.toBe(true);
    });

    it('still refuses the door question on a host that resolves to no tenant', async () => {
      // An unregistered host keeps F-066-u's answer — the neutral 404 — and
      // the panel reads that 404 as "nothing to mirror".
      const { context } = fakeExecutionContext({ url: '/api/auth/door' });

      await expect(guardWith({ probe: true }).canActivate(context)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /api/auth/door', () => {
    const ask = (tenant: Record<string, unknown>) => new DoorController().door({ tenant } as never);

    it("answers closed on a reseller's platform subdomain", async () => {
      await expect(ask(on())).resolves.toMatchObject({ ok: true, data: { serves: false } });
    });

    it.each([['subscription'], ['assets']])('answers closed on a %s domain', async (purpose) => {
      await expect(
        ask(on({ surfacePurpose: purpose, surfaceDomainType: 'custom_domain' })),
      ).resolves.toMatchObject({ data: { serves: false } });
    });

    it("answers open on a reseller's own custom domain", async () => {
      await expect(ask(on({ surfaceDomainType: 'custom_domain' }))).resolves.toMatchObject({
        data: { serves: true },
      });
    });

    it("answers open on the platform owner's own subdomain", async () => {
      await expect(ask(platform)).resolves.toMatchObject({ data: { serves: true } });
    });
  });
});
