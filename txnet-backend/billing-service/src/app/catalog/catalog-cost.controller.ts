import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { CATALOG_ADMIN_READ as READ, CATALOG_ADMIN_WRITE as WRITE } from './catalog-admin.rate-limit';
import { CatalogActor, CatalogAdminRefused } from './catalog-admin.service';
import {
  ListMeterCostsQuery,
  SetMeterCostBody,
  SetResellerMeterCostBody,
  SetVariantCostBody,
  UnsetMeterCostBody,
  UnsetResellerMeterCostBody,
  UnsetVariantCostBody,
  listMeterCostsSchema,
  setMeterCostSchema,
  setResellerMeterCostSchema,
  setVariantCostSchema,
  unsetMeterCostSchema,
  unsetResellerMeterCostSchema,
  unsetVariantCostSchema,
} from './catalog-cost.schema';
import { CatalogCostService, MeterCostInput, MeterCostUnsetInput, VariantCostInput } from './catalog-cost.service';
import { CatalogPermissionGuard } from './catalog-permission.guard';
import { CATALOG_REFUSAL_STATUS, catalogRefusal } from './catalog-refusal';
import { STATUS as RESELLER_STATUS } from './reseller-catalog.controller';
import { ResellerCatalogActor, ResellerCatalogRefused, ResellerCatalogService } from './reseller-catalog.service';

/** `platform` is the platform owner's own tenant (ADR-0142): the caller's, for the only caller who may ask. */
const ownerOf = (tenantId: string | undefined) => (tenantId === 'platform' ? undefined : tenantId);

/**
 * A product's cost on the ambient catalog (F-1002-d, ADR-0151, catalog
 * `contract.cost.md`): a variant's cost per sale and a meter's per unit, each
 * a history. Behind `CatalogPermissionGuard`, as every `/api/catalog` route.
 */
@Controller('catalog')
@UseGuards(CatalogPermissionGuard)
export class CatalogCostController {
  constructor(private readonly costs: CatalogCostService) {}

  @Get('variants/:id/costs')
  @RateLimit(READ)
  variantCosts(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.costs.variantCosts(actorOf(req, ip), id));
  }

  @Post('variants/:id/costs')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  setVariantCost(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(setVariantCostSchema)) body: SetVariantCostBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.costs.setVariantCost(actorOf(req, ip), id, body as VariantCostInput));
  }

  /** F-1002-i: the cost taken back — "not set" from `effectiveFrom` on. */
  @Post('variants/:id/costs/unset')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  unsetVariantCost(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(unsetVariantCostSchema)) body: UnsetVariantCostBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.costs.unsetVariantCost(actorOf(req, ip), id, body));
  }

  @Get('meter-costs')
  @RateLimit(READ)
  meterCosts(@Query(new ZodValidationPipe(listMeterCostsSchema)) query: ListMeterCostsQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.costs.meterCosts(actorOf(req, ip), ownerOf(query.tenantId)));
  }

  @Post('meter-costs')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  setMeterCost(@Body(new ZodValidationPipe(setMeterCostSchema)) body: SetMeterCostBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.costs.setMeterCost(actorOf(req, ip), { ...(body as MeterCostInput), tenantId: ownerOf(body.tenantId) }));
  }

  @Post('meter-costs/unset')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  unsetMeterCost(@Body(new ZodValidationPipe(unsetMeterCostSchema)) body: UnsetMeterCostBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.costs.unsetMeterCost(actorOf(req, ip), { ...(body as MeterCostUnsetInput), tenantId: ownerOf(body.tenantId) }));
  }

  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof CatalogAdminRefused)) throw e;
      throw catalogRefusal(CATALOG_REFUSAL_STATUS[e.reason], e.reason, e.message);
    }
  }
}

/**
 * The same for the reseller the path names (`/api/catalog/tenants/:tenantId`,
 * ADR-0064): `ResellerAccess` is the door, `read` for a list and `staffWrite`
 * for a write, and the work runs as the reseller — so a platform variant is
 * not found here, and a reseller never prices its cost of one (ADR-0151 (2)).
 */
@Controller('catalog/tenants/:tenantId')
export class ResellerCatalogCostController {
  constructor(
    private readonly reseller: ResellerCatalogService,
    private readonly costs: CatalogCostService,
  ) {}

  @Get('variants/:id/costs')
  @RateLimit(READ)
  variantCosts(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.reseller.run(resellerActorOf(req, ip), tenantId, 'read', (as) => this.costs.variantCosts(as, id)));
  }

  @Post('variants/:id/costs')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  setVariantCost(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setVariantCostSchema)) body: SetVariantCostBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.reseller.run(resellerActorOf(req, ip), tenantId, 'staffWrite', (as) => this.costs.setVariantCost(as, id, body as VariantCostInput)));
  }

  @Post('variants/:id/costs/unset')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  unsetVariantCost(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(unsetVariantCostSchema)) body: UnsetVariantCostBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.reseller.run(resellerActorOf(req, ip), tenantId, 'staffWrite', (as) => this.costs.unsetVariantCost(as, id, body)));
  }

  @Get('meter-costs')
  @RateLimit(READ)
  meterCosts(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.reseller.run(resellerActorOf(req, ip), tenantId, 'read', (as: CatalogActor) => this.costs.meterCosts(as)));
  }

  @Post('meter-costs')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  setMeterCost(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(setResellerMeterCostSchema)) body: SetResellerMeterCostBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.reseller.run(resellerActorOf(req, ip), tenantId, 'staffWrite', (as) => this.costs.setMeterCost(as, body as MeterCostInput)));
  }

  @Post('meter-costs/unset')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  unsetMeterCost(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(unsetResellerMeterCostSchema)) body: UnsetResellerMeterCostBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.reseller.run(resellerActorOf(req, ip), tenantId, 'staffWrite', (as) => this.costs.unsetMeterCost(as, body as MeterCostUnsetInput)));
  }

  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof ResellerCatalogRefused)) throw e;
      throw catalogRefusal(RESELLER_STATUS[e.reason], e.reason, e.message);
    }
  }
}

function actorOf(req: Request, ip: string): CatalogActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { adminId: userId, tenantId, ip, permissions };
}

function resellerActorOf(req: Request, ip: string): ResellerCatalogActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions, ip };
}
