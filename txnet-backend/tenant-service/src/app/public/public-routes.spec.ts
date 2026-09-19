import { PATH_METADATA } from '@nestjs/common/constants';
import { PUBLIC_ROUTE, PUBLIC_SURFACE, TenantContext } from '@txnet-backend/shared-core';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ServesPanelController } from '../domains/serves-panel.controller';
import { PublicHostMiddleware } from './public-host.middleware';

/** Every controller of this service, found on disk so a new one cannot be left out. */
const APP = join(__dirname, '..');

/**
 * tenant-service's public routes (F-018-ak, ADR-0065): everything under
 * `public/tenant/`, reached with no session. The host middleware names the
 * surface, `PublicRouteGuard` (shared-core, its own spec) holds each route to
 * its doors.
 */
describe('tenant-service public routes', () => {
  type Ctor = new (...a: never[]) => object;
  let classes: Ctor[] = [];

  beforeAll(async () => {
    const files = readdirSync(APP, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.controller.ts'));
    const modules = (await Promise.all(files.map((f) => import(join(APP, f))))) as Record<string, unknown>[];
    classes = modules
      .flatMap((m) => Object.values(m))
      .filter((v): v is Ctor => typeof v === 'function' && Reflect.hasMetadata(PATH_METADATA, v));
  });
  const pathsOf = (cls: object): string[] => [Reflect.getMetadata(PATH_METADATA, cls)].flat();
  const handlersOf = (cls: Ctor) =>
    Object.getOwnPropertyNames(cls.prototype)
      .filter((k) => k !== 'constructor')
      .map((k) => (cls.prototype as Record<string, unknown>)[k])
      .filter((h) => typeof h === 'function' && Reflect.hasMetadata('method', h as object));

  it('finds the controllers it checks', () => {
    expect(classes.length).toBeGreaterThan(10);
  });

  it('declares the doors of every handler under public/', () => {
    const undeclared = classes
      .filter((cls) => pathsOf(cls).some((p) => p.startsWith('public/')))
      .flatMap((cls) => handlersOf(cls).filter((h) => !Reflect.getMetadata(PUBLIC_ROUTE, h as object)).map(() => cls.name));
    expect(undeclared).toEqual([]);
  });

  it('declares doors only on a controller under public/', () => {
    const stray = classes
      .filter((cls) => !pathsOf(cls).some((p) => p.startsWith('public/tenant/')))
      .filter((cls) => handlersOf(cls).some((h) => Reflect.getMetadata(PUBLIC_ROUTE, h as object)))
      .map((cls) => cls.name);
    expect(stray).toEqual([]);
  });

  describe('PublicHostMiddleware', () => {
    const rows: Record<string, Record<string, unknown>> = {
      'shop-acme.com': {
        domainType: 'custom_domain', purpose: 'panel', verificationStatus: 'verified',
        tenant: { id: 'acme', tenantType: 'reseller' },
      },
    };
    const prisma = {
      tenantDomain: { findUnique: vi.fn(async ({ where }: { where: { domainValue: string } }) => rows[where.domainValue] ?? null) },
    };
    const middleware = new PublicHostMiddleware(prisma as never);

    it("puts the Host's surface on the request and opens its tenant's scope", async () => {
      const req: Record<string | symbol, unknown> = { headers: { host: 'Shop-Acme.com:443' } };
      let scoped: string | undefined;
      await middleware.use(req as never, {} as never, () => {
        scoped = TenantContext.current('spec').id;
      });
      expect(req[PUBLIC_SURFACE]).toMatchObject({ tenantId: 'acme', purpose: 'panel' });
      expect(scoped).toBe('acme');
    });

    it('marks a host with no surface as public and opens no scope', async () => {
      const req: Record<string | symbol, unknown> = { headers: { host: 'stranger.com' } };
      let scoped: unknown = 'unset';
      await middleware.use(req as never, {} as never, () => {
        scoped = TenantContext.currentOrNull();
      });
      expect(PUBLIC_SURFACE in req).toBe(true);
      expect(req[PUBLIC_SURFACE]).toBeNull();
      expect(scoped).toBeNull();
    });
  });

  describe('GET /api/public/tenant/serves-panel', () => {
    const controller = new ServesPanelController();
    const ask = (surface: Record<string, unknown>) => controller.servesPanel({ [PUBLIC_SURFACE]: surface } as never);

    it('says yes on an open panel door', () => {
      expect(ask({ purpose: 'panel', domainType: 'custom_domain', tenantType: 'reseller' })).toEqual({ serves: true });
      expect(ask({ purpose: 'panel', domainType: 'subdomain', tenantType: 'platform_owner' })).toEqual({ serves: true });
    });

    it("says no on an assets door and on a reseller's platform subdomain", () => {
      expect(ask({ purpose: 'assets', domainType: 'custom_domain', tenantType: 'reseller' })).toEqual({ serves: false });
      expect(ask({ purpose: 'panel', domainType: 'subdomain', tenantType: 'reseller' })).toEqual({ serves: false });
    });
  });
});
