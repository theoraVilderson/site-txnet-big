import { Module } from '@nestjs/common';

import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogAdminService } from './catalog-admin.service';
import { CatalogReadService } from './catalog-reads';

/**
 * The catalog, as a module inside billing-service (ADR-0049): the reads a
 * purchase and the Grant issue share (F-026-c), and management at
 * `/api/catalog` (F-026-d). No imports: `PrismaModule` is `@Global()`.
 */
@Module({
  controllers: [CatalogAdminController],
  providers: [CatalogReadService, CatalogAdminService],
  exports: [CatalogReadService],
})
export class CatalogModule {}
