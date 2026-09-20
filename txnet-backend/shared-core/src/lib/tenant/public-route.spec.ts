import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_SURFACE,
  PublicRoute,
  PublicRouteGuard,
  publicPath,
  surfaceOfHost,
} from './public-route';
// From its owner, not through `public-route`: the two services share one cache
// entry and therefore one shape, so it has exactly one home (`contract.public-routes.md`).
import type { HostSurface } from './host-surface';

/**
 * A public route (F-018-ak, ADR-0065) is a controller under
 * `public/<service>/`: Traefik sends the prefix to its service without
 * `my-auth`, the service's host middleware names the surface the Host proves,
 * and this guard holds each route to the doors it declared.
 */
describe('publicPath', () => {
  it('builds the reserved prefix for a service', () => {
    expect(publicPath('tenant', 'serves-panel')).toBe('public/tenant/serves-panel');
  });
});

describe('surfaceOfHost', () => {
  const rows: Record<string, Record<string, unknown>> = {
    'panel.txnet.app': {
      domainType: 'subdomain', purpose: 'panel', verificationStatus: 'verified',
      tenant: { id: 'platform', slug: 'platform', ownerUserId: 'u-0', tenantType: 'platform_owner' },
    },
    'shop-acme.com': {
      domainType: 'custom_domain', purpose: 'panel', verificationStatus: 'verified',
      tenant: { id: 'acme', slug: 'acme', ownerUserId: 'u-1', tenantType: 'reseller' },
    },
    'new-acme.com': {
      domainType: 'custom_domain', purpose: 'panel', verificationStatus: 'pending',
      tenant: { id: 'acme', slug: 'acme', ownerUserId: 'u-1', tenantType: 'reseller' },
    },
  };
  const db = {
    tenantDomain: {
      findUnique: vi.fn(async ({ where }: { where: { domainValue: string } }) => rows[where.domainValue] ?? null),
    },
  } as never;

  it('names the surface of a platform subdomain and a proved custom domain', async () => {
    await expect(surfaceOfHost(db, 'panel.txnet.app')).resolves.toEqual({
      id: 'platform', slug: 'platform', ownerUserId: 'u-0',
      purpose: 'panel', domainType: 'subdomain', tenantType: 'platform_owner',
    });
    await expect(surfaceOfHost(db, 'shop-acme.com')).resolves.toMatchObject({ id: 'acme' });
  });

  it('has no surface for an unproved custom domain, an unknown host, or none', async () => {
    await expect(surfaceOfHost(db, 'new-acme.com')).resolves.toBeNull();
    await expect(surfaceOfHost(db, 'stranger.com')).resolves.toBeNull();
    await expect(surfaceOfHost(db, null)).resolves.toBeNull();
  });
});

describe('PublicRouteGuard', () => {
  const guard = new PublicRouteGuard(new Reflector());
  const panel: HostSurface = { id: 't', slug: 't', ownerUserId: 'u-1', purpose: 'panel', domainType: 'custom_domain', tenantType: 'reseller' };
  const assets: HostSurface = { ...panel, purpose: 'assets' };
  const closed: HostSurface = { ...panel, domainType: 'subdomain' };

  class Files {
    @PublicRoute({ doors: ['panel', 'assets'] })
    serve() {}
  }
  class ServesPanel {
    @PublicRoute({ doors: 'any' })
    ask() {}
  }
  class Probe {
    @PublicRoute({ doors: 'none' })
    probe() {}
  }
  class Forgot {
    serve() {}
  }

  function run(handler: () => void, cls: object, request: Record<string | symbol, unknown>) {
    const context = {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
    return () => guard.canActivate(context);
  }

  it('passes a route that is not public', () => {
    expect(run(Forgot.prototype.serve, Forgot, {})()).toBe(true);
  });

  it('refuses a public request that reached a route with no @PublicRoute', () => {
    expect(run(Forgot.prototype.serve, Forgot, { [PUBLIC_SURFACE]: panel })).toThrow(NotFoundException);
  });

  it('refuses a public route reached around the host middleware', () => {
    expect(run(Files.prototype.serve, Files, {})).toThrow(NotFoundException);
  });

  it('serves a listed door and refuses an unlisted one, a closed one, and no surface', () => {
    expect(run(Files.prototype.serve, Files, { [PUBLIC_SURFACE]: panel })()).toBe(true);
    expect(run(Files.prototype.serve, Files, { [PUBLIC_SURFACE]: assets })()).toBe(true);
    expect(run(Files.prototype.serve, Files, { [PUBLIC_SURFACE]: { ...panel, purpose: 'subscription' } })).toThrow(
      NotFoundException,
    );
    expect(run(Files.prototype.serve, Files, { [PUBLIC_SURFACE]: closed })).toThrow(NotFoundException);
    expect(run(Files.prototype.serve, Files, { [PUBLIC_SURFACE]: null })).toThrow(NotFoundException);
  });

  it("'any' answers on every surface, closed ones included, and never on none", () => {
    expect(run(ServesPanel.prototype.ask, ServesPanel, { [PUBLIC_SURFACE]: closed })()).toBe(true);
    expect(run(ServesPanel.prototype.ask, ServesPanel, { [PUBLIC_SURFACE]: assets })()).toBe(true);
    expect(run(ServesPanel.prototype.ask, ServesPanel, { [PUBLIC_SURFACE]: null })).toThrow(NotFoundException);
  });

  it("'none' leaves the proof to the handler", () => {
    expect(run(Probe.prototype.probe, Probe, { [PUBLIC_SURFACE]: null })()).toBe(true);
  });
});
