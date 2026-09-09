import { NextFunction, Request, Response } from 'express';
import {
  ResolvedTenant,
  TenantContext,
  TenantContextMissing,
  runAcrossTenants,
  runWithTenant,
} from './tenant-context';
import { TenantContextMiddleware } from './tenant-context.middleware';

/**
 * ADR-0024 is a decision about a *failure mode*: forgetting to scope a query
 * must stop being possible, and the price is that code which escapes the async
 * context has no tenant. These tests hold both halves — that the scope survives
 * every await a real request makes, and that its absence throws rather than
 * quietly answering for no tenant.
 */

const TENANT: ResolvedTenant = {
  id: 'tenant-1',
  slug: 'reseller-a',
  via: 'domain',
};
const OTHER: ResolvedTenant = { id: 'tenant-2', slug: 'reseller-b', via: 'domain' };

describe('TenantContext — reading the scope', () => {
  it('throws outside any scope rather than answering for no tenant', () => {
    expect(() => TenantContext.current()).toThrow(TenantContextMissing);
    expect(TenantContext.currentOrNull()).toBeNull();
    expect(TenantContext.isAcrossTenants()).toBe(false);
  });

  it('names what was being attempted, so the throw is diagnosable', () => {
    expect(() => TenantContext.current('a user lookup')).toThrow(
      /a user lookup/,
    );
  });

  it('reads the tenant the scope was opened with', () => {
    runWithTenant(TENANT, () => {
      expect(TenantContext.current()).toBe(TENANT);
      expect(TenantContext.currentOrNull()).toBe(TENANT);
    });
  });

  it('closes the scope when the work finishes', () => {
    runWithTenant(TENANT, () => undefined);
    expect(TenantContext.currentOrNull()).toBeNull();
  });

  it('closes the scope when the work throws', () => {
    expect(() => runWithTenant(TENANT, () => { throw new Error('boom'); })).toThrow('boom');
    expect(TenantContext.currentOrNull()).toBeNull();
  });
});

describe('TenantContext — a resolved-to-nothing request', () => {
  // ADR-0025: an unknown host has no tenant, and that is an answer. It must
  // not read as "nobody opened a scope", because that is a bug in the caller.
  it('is a scope carrying null, and `current()` still refuses', () => {
    runWithTenant(null, () => {
      expect(TenantContext.currentOrNull()).toBeNull();
      expect(() => TenantContext.current()).toThrow(TenantContextMissing);
      expect(TenantContext.isAcrossTenants()).toBe(false);
    });
  });
});

describe('TenantContext — across async boundaries', () => {
  // The point of AsyncLocalStorage over a request-bound field: a service six
  // awaits deep still sees it. If this ever fails, every scoped query in a
  // request that awaits anything starts throwing.
  it('survives awaits, timers and Promise.all', async () => {
    await runWithTenant(TENANT, async () => {
      await Promise.resolve();
      expect(TenantContext.current()).toBe(TENANT);

      await new Promise((r) => setTimeout(r, 1));
      expect(TenantContext.current()).toBe(TENANT);

      const seen = await Promise.all([
        Promise.resolve().then(() => TenantContext.current().id),
        Promise.resolve().then(() => TenantContext.current().id),
      ]);
      expect(seen).toEqual(['tenant-1', 'tenant-1']);
    });
  });

  it('keeps two concurrent requests apart', async () => {
    const work = (tenant: ResolvedTenant) =>
      runWithTenant(tenant, async () => {
        await new Promise((r) => setTimeout(r, tenant === TENANT ? 5 : 1));
        return TenantContext.current().id;
      });

    // The slower one is started first on purpose: an implementation that kept
    // the tenant in a module-level variable would have it overwritten by the
    // second call and would pass with `toEqual(['tenant-2', 'tenant-2'])`.
    expect(await Promise.all([work(TENANT), work(OTHER)])).toEqual([
      'tenant-1',
      'tenant-2',
    ]);
  });

  it('restores the outer scope when a nested one ends', () => {
    runWithTenant(TENANT, () => {
      runWithTenant(OTHER, () => {
        expect(TenantContext.current()).toBe(OTHER);
      });
      expect(TenantContext.current()).toBe(TENANT);
    });
  });
});

describe('runAcrossTenants — the one escape', () => {
  it('is a scope of its own, not the absence of one', () => {
    runAcrossTenants(() => {
      expect(TenantContext.isAcrossTenants()).toBe(true);
      // Asking for *the* tenant inside the escape is a category error, so it
      // throws exactly as it would with no scope at all.
      expect(() => TenantContext.current()).toThrow(TenantContextMissing);
      expect(TenantContext.currentOrNull()).toBeNull();
    });
    expect(TenantContext.isAcrossTenants()).toBe(false);
  });

  it('shadows an open tenant scope while it runs', () => {
    runWithTenant(TENANT, () => {
      runAcrossTenants(() => {
        expect(TenantContext.isAcrossTenants()).toBe(true);
        expect(TenantContext.currentOrNull()).toBeNull();
      });
      expect(TenantContext.current()).toBe(TENANT);
      expect(TenantContext.isAcrossTenants()).toBe(false);
    });
  });
});

describe('TenantContextMiddleware', () => {
  const run = (req: unknown) => {
    const middleware = new TenantContextMiddleware();
    let seen: ResolvedTenant | null | undefined;
    const next: NextFunction = () => {
      seen = TenantContext.currentOrNull();
    };
    middleware.use(req as Request, {} as Response, next);
    return seen;
  };

  it('opens the scope with what TenantMiddleware resolved', () => {
    expect(run({ tenant: TENANT })).toBe(TENANT);
  });

  it('still opens a scope when the host resolved to no tenant', () => {
    // `undefined` would mean the middleware never ran; either way the request
    // gets a scope, so a scoped query fails as "no tenant" and not as
    // "no context", which is a different bug with a different fix.
    expect(run({ tenant: null })).toBeNull();
    expect(run({})).toBeNull();
  });

  it('leaves no scope open after the request', () => {
    run({ tenant: TENANT });
    expect(TenantContext.currentOrNull()).toBeNull();
  });
});
