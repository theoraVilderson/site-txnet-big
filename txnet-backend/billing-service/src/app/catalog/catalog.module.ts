import { Module } from '@nestjs/common';
import { ResellerAccess, TRANSLATOR, translatorFromEnv } from '@txnet-backend/shared-core';

import { LocaleModule } from '../locale/locale.module';
import { LocaleService } from '../locale/locale.service';
import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogAdminService } from './catalog-admin.service';
import { CatalogCostController, ResellerCatalogCostController } from './catalog-cost.controller';
import { CatalogCostService } from './catalog-cost.service';
import { CatalogReadService } from './catalog-reads';
import { CATALOG_TEXT_STORE, CatalogTextService } from './catalog-texts';
import { ResellerCatalogController } from './reseller-catalog.controller';
import { ResellerCatalogService } from './reseller-catalog.service';
import { SeasonInternalController } from './season-internal.controller';

/**
 * The catalog, as a module inside billing-service (ADR-0049): the reads a
 * purchase and the Grant issue share (F-026-c), and management at
 * `/api/catalog` (F-026-d). `PrismaModule` is `@Global()`; names are
 * locale-service entries, drafted by the `Translator` (F-1533-d, ADR-0050).
 *
 * Two controllers over one service (F-066-w7, ADR-0064): the ambient surface a
 * tenant manages its own catalog through, and the one that names a reseller in
 * its path. `ResellerAccess` is the second one's door; its reader is bound
 * beside the Prisma pools.
 */
@Module({
  imports: [LocaleModule],
  controllers: [CatalogAdminController, ResellerCatalogController, CatalogCostController, ResellerCatalogCostController, SeasonInternalController],
  providers: [
    CatalogReadService,
    CatalogAdminService,
    CatalogCostService,
    ResellerCatalogService,
    ResellerAccess,
    CatalogTextService,
    { provide: CATALOG_TEXT_STORE, useExisting: LocaleService },
    { provide: TRANSLATOR, useFactory: () => translatorFromEnv() },
  ],
  exports: [CatalogReadService],
})
export class CatalogModule {}
