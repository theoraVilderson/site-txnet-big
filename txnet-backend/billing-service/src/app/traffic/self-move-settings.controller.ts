import { Body, Controller, Get, Ip, NotFoundException, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { BackendI18nKeys, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { CATALOG_ADMIN_READ, CATALOG_ADMIN_WRITE } from '../catalog/catalog-admin.rate-limit';
import { adminOf, actorOf, resellerRefusal } from '../payment/gift/reseller-user-grants.controller';
import { ResellerUserGrantsRefused } from '../payment/gift/reseller-user-grants.service';
import { RateLimit } from '../request/rate-limit';
import { SelfMoveOwnBody, selfMoveOwnSchema } from './self-move-settings.schema';
import { SelfMoveSettingsRefused, SelfMoveSettingsService } from './self-move-settings.service';

const E = BackendI18nKeys.errors.billing;

/**
 * The self-move setting (F-410-a, `network/contract.config-move.md`
 * "Self-move"): `/api/billing/tenants/:tenantId/self-move-settings` — the
 * tenant's layer, and `/products/:productId` — one product's override. Every
 * answer is the whole view.
 *
 * **No permission guard**, as on every reseller-named surface: the catalog
 * door is inside the service, and the tenant is the path's. Catalog
 * management's budgets: it is set beside the product, by the same people.
 */
@Controller('billing/tenants/:tenantId/self-move-settings')
export class SelfMoveSettingsController {
  constructor(private readonly settings: SelfMoveSettingsService) {}

  @Get()
  @RateLimit(CATALOG_ADMIN_READ)
  read(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.settings.settings(actorOf(req), tenantId));
  }

  @Put()
  @RateLimit(CATALOG_ADMIN_WRITE)
  setTenant(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(selfMoveOwnSchema)) body: SelfMoveOwnBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.settings.setTenant(adminOf(req, ip), tenantId, { enabled: body.enabled, cooldownHours: body.cooldownHours }));
  }

  @Put('products/:productId')
  @RateLimit(CATALOG_ADMIN_WRITE)
  setProduct(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body(new ZodValidationPipe(selfMoveOwnSchema)) body: SelfMoveOwnBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.settings.setProduct(adminOf(req, ip), tenantId, productId, { enabled: body.enabled, cooldownHours: body.cooldownHours }));
  }

  /** The door's refusals as the user-grants surface answers them; a product it may not name is 404. */
  private async refusing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ResellerUserGrantsRefused) throw resellerRefusal(e);
      if (e instanceof SelfMoveSettingsRefused) throw new NotFoundException({ i18nKey: E.productNotFound, reason: e.reason, message: e.message });
      throw e;
    }
  }
}
