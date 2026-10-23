import { Module } from '@nestjs/common';

import { TrafficModule } from '../traffic/traffic.module';
import { GrantGroupMoveController } from './grant-group-move.controller';
import { GrantGroupMoveService } from './grant-group-move';
import { PanelCredentialClient } from './panel-credential.client';
import { InboundAudienceController } from './inbound-audience.controller';
import { PanelGroupsService } from './panel-groups';
import { InboundReleaseService } from './inbound-release';
import { MemberInboundsService } from './member-inbounds';
import { PanelInboundsService } from './panel-inbounds';
import { PanelCostController } from './panel-cost.controller';
import { PanelCostService } from './panel-cost';
import { PanelLifecycleService } from './panel-lifecycle';
import { PANEL_CREDENTIAL_WRITER, PanelRegistrationService } from './panel-registration';
import { SystemsReadService } from './systems-read';
import { PanelPermissionGuard, SystemsController } from './systems.controller';
import { UsageHoldsService } from './usage-holds';

/**
 * The platform owner's systems surface (F-027-ar, ADR-0080): the routes behind
 * the systems page (F-027-ad). Every one writes or reads desired state and
 * observations in the database; nothing here calls `network-service`, which
 * has no route to call (ADR-0071).
 *
 * `TrafficModule` for moving a Grant to another group (F-027-et), which
 * fulfils it; `PrismaModule` is `@Global()` and `ConfigModule` is global. A
 * panel's login is written through `PanelCredentialClient`, a call to
 * `tenant-service` — this service loads no vault writer (ADR-0039).
 */
@Module({
  imports: [TrafficModule],
  controllers: [SystemsController, PanelCostController, InboundAudienceController, GrantGroupMoveController],
  providers: [
    GrantGroupMoveService,
    PanelRegistrationService,
    SystemsReadService,
    UsageHoldsService,
    PanelGroupsService,
    PanelInboundsService,
    MemberInboundsService,
    InboundReleaseService,
    PanelLifecycleService,
    PanelCostService,
    PanelPermissionGuard,
    PanelCredentialClient,
    { provide: PANEL_CREDENTIAL_WRITER, useExisting: PanelCredentialClient },
  ],
  // A reseller's own router is registered behind the import's door (F-1601-g, ADR-0162).
  exports: [PanelRegistrationService],
})
export class SystemsModule {}
