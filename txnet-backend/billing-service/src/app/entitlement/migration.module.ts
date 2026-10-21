import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { TrafficModule } from '../traffic/traffic.module';
import { EntitlementModule } from './entitlement.module';
import { MigrationCommitService } from './migration-commit';
import { MigrationDrainService } from './migration-drain';
import { MigrationPreviewService } from './migration-preview';
import { MigrationRunInternalController, ResellerMigrationRunController } from './migration-run.controller';
import { MigrationRunService } from './migration-run';
import { ImportedPeople, SourceLoginVault, SourceSnapshotReader } from './migration-seams';

/**
 * A reseller's import from another panel (F-206, F-207, D-63), as
 * entitlement's own module: the run, its dry run, its commit and the seams it
 * reads the source, finds its people and ends its login through. The commit
 * issues through `GrantService` and places through group fulfilment, hence
 * the two imports. The background work is `worker-service`'s clock (ADR-0027).
 */
@Module({
  imports: [EntitlementModule, TrafficModule],
  controllers: [ResellerMigrationRunController, MigrationRunInternalController],
  providers: [MigrationRunService, MigrationPreviewService, MigrationCommitService, MigrationDrainService, SourceSnapshotReader, SourceLoginVault, ImportedPeople, ResellerAccess],
})
export class MigrationModule {}
