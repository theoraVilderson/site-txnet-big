import { Module } from '@nestjs/common';
import { TRANSLATOR, translatorFromEnv } from '@txnet-backend/shared-core';

import { LocaleModule } from '../locale/locale.module';
import { LocaleService } from '../locale/locale.service';
import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogAdminService } from './catalog-admin.service';
import { CatalogReadService } from './catalog-reads';
import { CATALOG_TEXT_STORE, CatalogTextService } from './catalog-texts';

/**
 * The catalog, as a module inside billing-service (ADR-0049): the reads a
 * purchase and the Grant issue share (F-026-c), and management at
 * `/api/catalog` (F-026-d). `PrismaModule` is `@Global()`; names are
 * locale-service entries, drafted by the `Translator` (F-1533-d, ADR-0050).
 */
@Module({
  imports: [LocaleModule],
  controllers: [CatalogAdminController],
  providers: [
    CatalogReadService,
    CatalogAdminService,
    CatalogTextService,
    { provide: CATALOG_TEXT_STORE, useExisting: LocaleService },
    { provide: TRANSLATOR, useFactory: () => translatorFromEnv() },
  ],
  exports: [CatalogReadService],
})
export class CatalogModule {}
