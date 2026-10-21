import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { MigrationDrainService } from './migration-drain';
import { MigrationPreviewService } from './migration-preview';
import { MigrationRunInternalController, ResellerMigrationRunController } from './migration-run.controller';
import { MigrationRunService } from './migration-run';
import { SourceLoginVault, SourceSnapshotReader } from './migration-seams';

/**
 * A reseller's import from another panel (F-206, D-63), as entitlement's own
 * module: the run, its dry run and the seams it reads the source and ends its
 * login through. The background work is `worker-service`'s clock (ADR-0027).
 */
@Module({
  controllers: [ResellerMigrationRunController, MigrationRunInternalController],
  providers: [MigrationRunService, MigrationPreviewService, MigrationDrainService, SourceSnapshotReader, SourceLoginVault, ResellerAccess],
})
export class MigrationModule {}
