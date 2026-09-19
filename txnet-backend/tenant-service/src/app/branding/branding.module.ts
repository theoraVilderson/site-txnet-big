import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { FilesModule } from '../files/files.module';
import { BrandingPublicController, TenantBrandingController } from './tenant-branding.controller';
import { TenantBrandingService } from './tenant-branding.service';

/**
 * A reseller's branding (F-018-h): its images through `FilesModule`'s
 * `ObjectStorage`, its text on `tenant_branding`.
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  imports: [FilesModule],
  controllers: [TenantBrandingController, BrandingPublicController],
  providers: [TenantBrandingService, ResellerAccess],
})
export class BrandingModule {}
