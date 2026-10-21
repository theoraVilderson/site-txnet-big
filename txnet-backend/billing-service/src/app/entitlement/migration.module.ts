import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { TrafficModule } from '../traffic/traffic.module';
import { UsageModule } from '../usage/usage.module';
import { EntitlementModule } from './entitlement.module';
import { MigrationCommitService } from './migration-commit';
import { MigrationDrainService } from './migration-drain';
import { MigrationPreviewService } from './migration-preview';
import { MigrationRollbackService } from './migration-rollback';
import { MigrationRunInternalController, ResellerMigrationRunController } from './migration-run.controller';
import { MigrationRunService } from './migration-run';
import { ImportedPeople, SourceLoginVault, SourceSnapshotReader } from './migration-seams';

/**
 * A reseller's import from another panel (F-206, F-207, F-211, D-63), as
 * entitlement's own module: the run, its dry run, its commit, its rollback and
 * the seams it reads the source, finds and removes its people and ends its
 * login through. The commit issues through `GrantService` and places through
 * group fulfilment; the rollback closes as an admin's delete, settling every
 * meter — hence the three imports. The background work is `worker-service`'s clock (ADR-0027).
 */
@Module({
  imports: [EntitlementModule, TrafficModule, UsageModule],
  controllers: [ResellerMigrationRunController, MigrationRunInternalController],
  providers: [MigrationRunService, MigrationPreviewService, MigrationCommitService, MigrationRollbackService, MigrationDrainService, SourceSnapshotReader, SourceLoginVault, ImportedPeople, ResellerAccess],
})
export class MigrationModule {}
