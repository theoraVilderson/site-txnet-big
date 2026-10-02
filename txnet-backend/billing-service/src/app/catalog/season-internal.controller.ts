import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { CatalogAdminService } from './catalog-admin.service';

/**
 * F-505-a: the seasons' writer, for F-505-b's worker job —
 * `POST /api/internal/catalog/seasons/write-upcoming`, service token only
 * (`ServiceOnlyGuard`, a neutral 404 to anyone else). Every tenant's seasons;
 * safe to run twice (`CatalogAdminService.writeUpcomingSeasons`).
 */
@TenantCapability('system')
@Controller('internal/catalog/seasons')
@UseGuards(ServiceOnlyGuard)
export class SeasonInternalController {
  constructor(private readonly catalog: CatalogAdminService) {}

  @Post('write-upcoming')
  @HttpCode(200)
  async writeUpcoming() {
    return this.catalog.writeUpcomingSeasons(new Date());
  }
}
