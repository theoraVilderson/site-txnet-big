import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { FilesModule } from '../files/files.module';
import { TenantDataExportController, TenantDataExportInternalController } from './tenant-data-export.controller';
import { TenantDataExportDrain } from './tenant-data-export.drain';
import { TenantDataExportService } from './tenant-data-export.service';

/**
 * A reseller takes its data (F-212-a, catalog §14.8): the request, the drain
 * that builds the archive, and the signed link. The archive goes through
 * `FilesModule`'s `ObjectStorage`. `PrismaModule` is `@Global`.
 */
@Module({
  imports: [FilesModule],
  controllers: [TenantDataExportController, TenantDataExportInternalController],
  providers: [TenantDataExportService, TenantDataExportDrain, ResellerAccess],
})
export class DataExportModule {}
