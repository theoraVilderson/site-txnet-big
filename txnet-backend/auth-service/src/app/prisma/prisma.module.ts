import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { CrossTenantPrismaService } from './cross-tenant-prisma.service';
import { withTenant } from '../tenant-context/with-tenant';

/**
 * The two pools this service talks to Postgres through (ADR-0024, F-066-m-a,
 * F-066-m-b).
 *
 * `PrismaService` is the one nearly everything injects: the tenant scoping is
 * already applied, and it connects as the role Row-Level Security actually
 * binds. `CrossTenantPrismaService` is the other one, for the handful of reads
 * that resolve a tenant and therefore cannot run inside one — see that class.
 *
 * `PrismaService` is a factory rather than the plain class because `$extends`
 * returns a *new* client instead of mutating the one it extends — a subclass
 * cannot override a model accessor, since Prisma defines those on the instance.
 * Doing it here means every service keeps injecting `PrismaService` and none of
 * them opts in: the twenty-odd `prisma.user.*` call sites are scoped without
 * being edited, and so is the next one.
 *
 * The extended client forwards `onModuleInit` / `onModuleDestroy` to the base
 * instance, so Nest still owns the connection lifecycle, and it is the only
 * instance registered — the base is created here and never provided, so
 * `$connect` still happens exactly once.
 *
 * `withTenant` is handed the *base* client: it opens the transaction that binds
 * `app.tenant_id` beside each query, and the extended client is not built yet
 * at that point. `$extends` leaves the base alone, so the two coexist.
 *
 * The cross-tenant client is deliberately **not** extended. `withTenant` would
 * demand an ambient tenant for every registered model, which is the one thing
 * its callers do not have — the read is what produces the tenant. What confines
 * it is the database: its role's policy is `USING (true)`, granted per table and
 * revocable per table, and it holds no `BYPASSRLS`.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const base = new PrismaService(
          config.getOrThrow<string>('DATABASE_APP_URL'),
        );
        return base.$extends(withTenant(base)) as unknown as PrismaService;
      },
    },
    {
      provide: CrossTenantPrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new CrossTenantPrismaService(
          config.getOrThrow<string>('DATABASE_CROSS_TENANT_URL'),
        ),
    },
  ],
  exports: [PrismaService, CrossTenantPrismaService],
})
export class PrismaModule {}
