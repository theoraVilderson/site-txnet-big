import { Module } from '@nestjs/common';

import { CatalogReadService } from './catalog-reads';

/**
 * The catalog, as a module inside billing-service (ADR-0049). Reads only for
 * now (F-026-c); management routes join with F-026-d. Exported so the Grant
 * issue (F-026-e) and a purchase read the same prices.
 */
@Module({
  providers: [CatalogReadService],
  exports: [CatalogReadService],
})
export class CatalogModule {}
