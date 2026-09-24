import { Module } from '@nestjs/common';

import { PanelCredentialClient } from './panel-credential.client';
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
 * No imports: `PrismaModule` is `@Global()` and `ConfigModule` is global. A
 * panel's login is written through `PanelCredentialClient`, a call to
 * `tenant-service` — this service loads no vault writer (ADR-0039).
 */
@Module({
  controllers: [SystemsController],
  providers: [
    PanelRegistrationService,
    SystemsReadService,
    UsageHoldsService,
    PanelPermissionGuard,
    PanelCredentialClient,
    { provide: PANEL_CREDENTIAL_WRITER, useExisting: PanelCredentialClient },
  ],
})
export class SystemsModule {}
