/**
 * `tenant-service`'s edge (F-018-t, ADR-0058) — the app with no business routes
 * yet, whose wiring every route moved in later inherits without opting in.
 *
 * What would break silently here, and nowhere else:
 *  - **`TenantStatusGuard` is an `APP_GUARD`** (C-11): a suspended reseller's
 *    staff write would otherwise reach the first route moved here;
 *  - **the identity is the gate's, all or nothing**: a request without the
 *    forward-auth headers is refused, never served under a `null` tenant, and a
 *    complete set opens the scope of `X-Tenant-Id`;
 *  - **the environment refuses to boot half-configured**: both pools are
 *    required, and production without `SERVICE_AUTH_TOKEN` is refused.
 */
import { UnauthorizedException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { IdentityHeaders, RateLimitGuard, TenantContext, TenantStatusGuard } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { AppModule } from './app.module';
import { envSchema } from './config/env.validation';
import { IdentityMiddleware, identityOf } from './request/identity.middleware';

// Importing `AppModule` runs `ConfigModule.forRoot`, which validates an empty
// environment; the schema itself is tested below, unmocked.
vi.mock('./config/env.validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/env.validation')>();
  return { ...actual, envConfigOptions: { ...actual.envConfigOptions, validate: (raw: Record<string, unknown>) => raw } };
});

const TENANT = '22222222-2222-4222-8222-222222222222';

function request(headers: Record<string, string>): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: lower } as unknown as Request;
}

const gated = {
  [IdentityHeaders.userId]: '44444444-4444-4444-8444-444444444444',
  [IdentityHeaders.tenantId]: TENANT,
  [IdentityHeaders.roleId]: '33333333-3333-4333-8333-333333333333',
  [IdentityHeaders.sessionId]: 'session-1',
  [IdentityHeaders.permissions]: 'tenant.manage, ',
};

const env = {
  DATABASE_APP_URL: 'postgresql://app',
  DATABASE_CROSS_TENANT_URL: 'postgresql://cross',
  REDIS_URL: 'redis://redis:6379',
};

describe('AppModule', () => {
  it('registers TenantStatusGuard and RateLimitGuard as app guards', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) as Array<{ provide?: unknown; useClass?: unknown }>;
    const guards = providers.filter((p) => p.provide === APP_GUARD).map((p) => p.useClass);
    expect(guards).toEqual(expect.arrayContaining([TenantStatusGuard, RateLimitGuard]));
  });
});

describe('IdentityMiddleware', () => {
  it('refuses a request that did not come through the gate', () => {
    const next = vi.fn();
    expect(() => new IdentityMiddleware().use(request({}), {} as never, next)).toThrow(UnauthorizedException);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a partial header set', () => {
    const { [IdentityHeaders.sessionId]: _dropped, ...partial } = gated;
    expect(() => new IdentityMiddleware().use(request(partial), {} as never, vi.fn())).toThrow(UnauthorizedException);
  });

  it("opens the forwarded tenant's scope for the rest of the request", () => {
    const req = request(gated);
    let scoped: string | undefined;
    new IdentityMiddleware().use(req, {} as never, () => {
      scoped = TenantContext.current().id;
    });
    expect(scoped).toBe(TENANT);
    expect(identityOf(req).permissions).toEqual(['tenant.manage']);
  });
});

describe('envSchema', () => {
  it('boots in development with both pools and Redis', () => {
    expect(envSchema.safeParse(env).success).toBe(true);
  });

  it.each(['DATABASE_APP_URL', 'DATABASE_CROSS_TENANT_URL', 'REDIS_URL'])('refuses to boot without %s', (name) => {
    const { [name as keyof typeof env]: _missing, ...rest } = env;
    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it('refuses production without SERVICE_AUTH_TOKEN', () => {
    expect(envSchema.safeParse({ ...env, NODE_ENV: 'production' }).success).toBe(false);
    expect(envSchema.safeParse({ ...env, NODE_ENV: 'production', SERVICE_AUTH_TOKEN: 't' }).success).toBe(true);
  });
});
