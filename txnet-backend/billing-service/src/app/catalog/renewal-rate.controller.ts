import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '@txnet-backend/shared-core';

import { RateLimit } from '../request/rate-limit';
import { CATALOG_ADMIN_READ as READ, CATALOG_ADMIN_WRITE as WRITE } from './catalog-admin.rate-limit';
import { CatalogActor } from './catalog-admin.service';
import { catalogActorOf, refusingCatalog, refusingResellerCatalog, resellerCatalogActorOf } from './catalog-door';
import { CatalogPermissionGuard } from './catalog-permission.guard';
import { ResellerCatalogService } from './reseller-catalog.service';
import { OffRenewalRateBody, SetRenewalRateBody, offRenewalRateSchema, setRenewalRateSchema } from './renewal-rate.schema';
import { RenewalRateService } from './renewal-rate.service';

/**
 * A product's renewal rate on the ambient catalog (F-305-b, ADR-0158, catalog
 * `contract.renewal-rate.md`): set on the product's own routes, a history.
 * Behind `CatalogPermissionGuard`, as every `/api/catalog` route.
 */
@Controller('catalog')
@UseGuards(CatalogPermissionGuard)
export class RenewalRateController {
  constructor(private readonly rates: RenewalRateService) {}

  @Get('products/:id/renewal-rates')
  @RateLimit(READ)
  list(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return refusingCatalog(() => this.rates.rates(catalogActorOf(req, ip), id));
  }

  @Post('products/:id/renewal-rates')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  set(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(setRenewalRateSchema)) body: SetRenewalRateBody, @Req() req: Request, @Ip() ip: string) {
    return refusingCatalog(() => this.rates.set(catalogActorOf(req, ip), id, body));
  }

  /** Custom renewal switched off from `effectiveFrom` — a row with no rate. */
  @Post('products/:id/renewal-rates/off')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  off(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(offRenewalRateSchema)) body: OffRenewalRateBody, @Req() req: Request, @Ip() ip: string) {
    return refusingCatalog(() => this.rates.off(catalogActorOf(req, ip), id, body));
  }
}

/**
 * The same for the reseller the path names (`/api/catalog/tenants/:tenantId`,
 * ADR-0064): `ResellerAccess` is the door, `read` for the list and
 * `staffWrite` for a write, and the work runs as the reseller — so a platform
 * product is not found here: a reseller renews it at the platform's rate.
 */
@Controller('catalog/tenants/:tenantId')
export class ResellerRenewalRateController {
  constructor(
    private readonly reseller: ResellerCatalogService,
    private readonly rates: RenewalRateService,
  ) {}

  @Get('products/:id/renewal-rates')
  @RateLimit(READ)
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return refusingResellerCatalog(() => this.reseller.run(resellerCatalogActorOf(req, ip), tenantId, 'read', (as: CatalogActor) => this.rates.rates(as, id)));
  }

  @Post('products/:id/renewal-rates')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  set(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setRenewalRateSchema)) body: SetRenewalRateBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusingResellerCatalog(() => this.reseller.run(resellerCatalogActorOf(req, ip), tenantId, 'staffWrite', (as: CatalogActor) => this.rates.set(as, id, body)));
  }

  @Post('products/:id/renewal-rates/off')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  off(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(offRenewalRateSchema)) body: OffRenewalRateBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusingResellerCatalog(() => this.reseller.run(resellerCatalogActorOf(req, ip), tenantId, 'staffWrite', (as: CatalogActor) => this.rates.off(as, id, body)));
  }
}
