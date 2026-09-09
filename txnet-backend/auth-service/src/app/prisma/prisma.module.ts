import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { withTenant } from '../tenant-context/with-tenant';

/**
 * The `PrismaService` token resolves to a client with the tenant scoping
 * already applied (ADR-0024 decision 2, F-066-b).
 *
 * It is a factory rather than the plain class because `$extends` returns a
 * *new* client instead of mutating the one it extends — a subclass cannot
 * override a model accessor, since Prisma defines those on the instance. Doing
 * it here means every service keeps injecting `PrismaService` and none of them
 * opts in: the twenty-odd `prisma.user.*` call sites are scoped without being
 * edited, and so is the next one.
 *
 * The extended client forwards `onModuleInit` / `onModuleDestroy` to the base
 * instance, so Nest still owns the connection lifecycle, and it is the only
 * instance registered — the base is created here and never provided, so
 * `$connect` still happens exactly once.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () =>
        new PrismaService().$extends(withTenant()) as unknown as PrismaService,
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
