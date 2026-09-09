import { Module } from '@nestjs/common';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * `tenant`'s first module. It has no controller: nothing outside this process
 * asks for a tenant by name yet — the resolver is consumed by the edge
 * middleware and, from F-061-b, by `register`.
 *
 * `PrismaModule` is `@Global`, so it is not imported here.
 */
@Module({
  providers: [TenantResolverService],
  exports: [TenantResolverService],
})
export class TenantModule {}
