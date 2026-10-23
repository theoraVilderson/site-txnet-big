import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { SystemsModule } from '../systems/systems.module';
import { TrafficModule } from '../traffic/traffic.module';
import { UsageModule } from '../usage/usage.module';
import { BalanceImportService } from '../wallet/balance-import-run';
import { WalletModule } from '../wallet/wallet.module';
import { EntitlementModule } from './entitlement.module';
import { LegacyHostService } from './legacy-host';
import { MigrationCommitService } from './migration-commit';
import { MigrationDrainService } from './migration-drain';
import { MigrationLinkService } from './migration-link-run';
import { MigrationRouterService } from './migration-router';
import { MigrationPreviewService } from './migration-preview';
import { MigrationRollbackService } from './migration-rollback';
import { MigrationRunInternalController, ResellerMigrationRunController } from './migration-run.controller';
import { MigrationRunService } from './migration-run';
import { ImportedPeople, SourceLoginVault, SourceSnapshotReader, SubscriptionLinkProbe } from './migration-seams';

/**
 * A reseller's import from another panel (F-206, F-207, F-211, D-63), as
 * entitlement's own module: the run, its dry run, its commit, its rollback and
 * the seams it reads the source, finds and removes its people and ends its
 * login through, and the old hosts its users' links answer on (F-204-b). The commit issues through `GrantService` and places through
 * group fulfilment; the rollback closes as an admin's delete, settling every
 * meter — hence the three imports; a balance file credits and takes back wallets (F-209-a), hence the fourth; a reseller registers its own router through the systems registration (F-1601-g), hence the fifth. The background work is `worker-service`'s clock (ADR-0027).
 */
@Module({
  imports: [EntitlementModule, TrafficModule, UsageModule, WalletModule, SystemsModule],
  controllers: [ResellerMigrationRunController, MigrationRunInternalController],
  providers: [MigrationRunService, MigrationLinkService, BalanceImportService, MigrationPreviewService, MigrationCommitService, MigrationRollbackService, MigrationDrainService, SourceSnapshotReader, SourceLoginVault, ImportedPeople, SubscriptionLinkProbe, LegacyHostService, MigrationRouterService, ResellerAccess],
})
export class MigrationModule {}
