import {
  ResolvedTenant,
  TenantContextMissing,
  TenantScopeConflict,
  runAcrossTenants,
  runWithTenant,
} from './tenant-context';
import {
  TENANT_SCOPED_MODELS,
  scopeArgs,
  tenantScopeQueryMap,
} from './with-tenant';

/**
 * F-066-b turns one guarantee on: a query on a registered model either carries
 * a `tenantId` or throws, with no third outcome. What is worth asserting here
 * is that third outcome never appearing — an operation shape the rewriter does
 * not recognise, or a caller's own `tenantId` quietly replaced — because that
 * is the case that fails silently and returns another tenant's rows.
 */

const TENANT: ResolvedTenant = { id: 'tenant-1', slug: 'a', via: 'domain' };

describe('scopeArgs — every operation shape carries the tenant', () => {
  it('filters a read, including a findUnique on a unique column', () => {
    expect(scopeArgs('findUnique', { where: { username: 'ali' } }, 'tenant-1', 'user.findUnique')).toEqual({
      where: { username: 'ali', tenantId: 'tenant-1' },
    });
  });

  it('ANDs the tenant onto an OR rather than into one of its branches', () => {
    // The register duplicate check (`register.service.ts`) asks "is this
    // username OR this phone already taken?". Since F-065-b the answer is
    // per tenant, so the tenant has to bind the whole question: a tenantId
    // pushed into either branch would leave the other branch platform-wide
    // and answer `register.duplicateUser` about a tenant the caller cannot
    // see — the cross-tenant leak ADR-0023 exists to close.
    expect(
      scopeArgs(
        'findFirst',
        { where: { OR: [{ username: 'ali' }, { phoneNumber: '+989123456789' }] } },
        'tenant-1',
        'user.findFirst',
      ),
    ).toEqual({
      where: {
        OR: [{ username: 'ali' }, { phoneNumber: '+989123456789' }],
        tenantId: 'tenant-1',
      },
    });
  });

  it('filters a read that had no `where` at all', () => {
    expect(scopeArgs('count', undefined, 'tenant-1', 'user.count')).toEqual({
      where: { tenantId: 'tenant-1' },
    });
  });

  it('filters an update and a delete, not just a find', () => {
    for (const operation of ['update', 'delete', 'updateMany', 'deleteMany']) {
      expect(
        (scopeArgs(operation, { where: { id: 'u1' } }, 'tenant-1', operation) as { where: unknown })
          .where,
      ).toEqual({ id: 'u1', tenantId: 'tenant-1' });
    }
  });

  it('writes the tenant into a create, and into every row of a createMany', () => {
    expect(scopeArgs('create', { data: { username: 'ali' } }, 'tenant-1', 'user.create')).toEqual({
      data: { username: 'ali', tenantId: 'tenant-1' },
    });
    expect(
      (scopeArgs('createMany', { data: [{ username: 'a' }, { username: 'b' }] }, 'tenant-1', 'user.createMany') as {
        data: unknown;
      }).data,
    ).toEqual([
      { username: 'a', tenantId: 'tenant-1' },
      { username: 'b', tenantId: 'tenant-1' },
    ]);
  });

  it('scopes both halves of an upsert', () => {
    const scoped = scopeArgs(
      'upsert',
      { where: { id: 'u1' }, create: { username: 'ali' }, update: { fullName: 'Ali' } },
      'tenant-1',
      'user.upsert',
    ) as { where: unknown; create: unknown; update: unknown };
    expect(scoped.where).toEqual({ id: 'u1', tenantId: 'tenant-1' });
    expect(scoped.create).toEqual({ username: 'ali', tenantId: 'tenant-1' });
    expect(scoped.update).toEqual({ fullName: 'Ali' });
  });

  it('leaves a matching tenantId alone rather than duplicating the rule', () => {
    expect(
      scopeArgs('findFirst', { where: { tenantId: 'tenant-1', username: 'ali' } }, 'tenant-1', 'user.findFirst'),
    ).toEqual({ where: { tenantId: 'tenant-1', username: 'ali' } });
  });

  it('refuses a query that names a different tenant instead of overwriting it', () => {
    expect(() =>
      scopeArgs('findFirst', { where: { tenantId: 'tenant-2' } }, 'tenant-1', 'user.findFirst'),
    ).toThrow(TenantScopeConflict);
    expect(() =>
      scopeArgs('create', { data: { tenantId: 'tenant-2' } }, 'tenant-1', 'user.create'),
    ).toThrow(TenantScopeConflict);
  });

  it('refuses an operation it does not know how to scope, rather than passing it through', () => {
    expect(() => scopeArgs('findRaw', {}, 'tenant-1', 'user.findRaw')).toThrow(
      TenantScopeConflict,
    );
  });
});

describe('withTenant — the extension around a query', () => {
  const run = async (fn: () => Promise<unknown>) => fn();

  /** The `$allOperations` hook the extension installs for a registered model. */
  const hookFor = (model: string) =>
    (
      tenantScopeQueryMap() as Record<
        string,
        { $allOperations: (p: unknown) => Promise<unknown> }
      >
    )[model].$allOperations;
  const hook = () => hookFor(TENANT_SCOPED_MODELS[0]);

  it('registers exactly the models the registry names', () => {
    expect(Object.keys(tenantScopeQueryMap())).toEqual([
      ...TENANT_SCOPED_MODELS,
    ]);
  });

  it('passes the scoped arguments to the query', async () => {
    const query = jest.fn().mockResolvedValue(null);
    await run(() =>
      runWithTenant(TENANT, () =>
        hook()({ model: 'user', operation: 'findFirst', args: { where: { username: 'ali' } }, query }),
      ),
    );
    expect(query).toHaveBeenCalledWith({ where: { username: 'ali', tenantId: 'tenant-1' } });
  });

  it('throws instead of running a query with no tenant in scope', async () => {
    const query = jest.fn();
    await expect(
      hook()({ model: 'user', operation: 'findFirst', args: {}, query }),
    ).rejects.toThrow(TenantContextMissing);
    expect(query).not.toHaveBeenCalled();
  });

  it('throws for a request that resolved to no tenant, too', async () => {
    const query = jest.fn();
    await expect(
      runWithTenant(null, () =>
        hook()({ model: 'user', operation: 'findFirst', args: {}, query }),
      ),
    ).rejects.toThrow(TenantContextMissing);
    expect(query).not.toHaveBeenCalled();
  });

  it('scopes a bot link the same way, so a chat id is unique within a tenant', async () => {
    // F-066-l / catalog 10.5: the messenger issues one chat id per person, so
    // the same human answering two resellers' bots presents the same id to
    // both. Without this registry entry the "is this chat taken?" lookup is
    // answered from every tenant's rows at once, and the second reseller is
    // told the chat belongs to somebody else's account.
    const query = jest.fn().mockResolvedValue(null);
    await run(() =>
      runWithTenant(TENANT, () =>
        hookFor('linkedBotAccount')({
          model: 'linkedBotAccount',
          operation: 'upsert',
          args: {
            where: { userId_platform: { userId: 'u-1', platform: 'telegram' } },
            create: { userId: 'u-1', platform: 'telegram', platformUserId: '55501' },
          },
          query,
        }),
      ),
    );
    expect(query).toHaveBeenCalledWith({
      where: {
        userId_platform: { userId: 'u-1', platform: 'telegram' },
        tenantId: TENANT.id,
      },
      create: {
        userId: 'u-1',
        platform: 'telegram',
        platformUserId: '55501',
        tenantId: TENANT.id,
      },
    });
  });

  it('leaves the query untouched inside the audited escape', async () => {
    const query = jest.fn().mockResolvedValue(null);
    const args = { where: { username: 'ali' } };
    await run(() =>
      runAcrossTenants(() =>
        hook()({ model: 'user', operation: 'findFirst', args, query }),
      ),
    );
    expect(query).toHaveBeenCalledWith(args);
  });
});
