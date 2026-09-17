import { Module } from '@nestjs/common';

import { TenantPackageController } from './tenant-package.controller';
import { TenantPackageService } from './tenant-package.service';

/**
 * The packages the platform sells resellers (F-018-d, F-018-o), moved out of
 * `auth-service` with F-018-u (ADR-0058).
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here;
 * the two pools the service injects come from there.
 */
@Module({
  controllers: [TenantPackageController],
  providers: [TenantPackageService],
})
export class PackagesModule {}
