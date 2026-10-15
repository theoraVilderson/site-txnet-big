import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GATEWAY_ADMIN_READ as READ, GATEWAY_ADMIN_WRITE as WRITE } from './gateway-admin.rate-limit';
import {
  CreateResellerGatewayBody,
  DepositPresetsBody,
  DepositTaxBody,
  GatewayAudienceBody,
  UpdateGatewayBody,
  createResellerGatewaySchema,
  depositPresetsSchema,
  depositTaxSchema,
  gatewayAudienceSchema,
  updateGatewaySchema,
} from './gateway-admin.schema';
import { gatewaySource, refusing } from './gateway-admin.http';
import { ResellerCreateGatewayInput, ResellerGatewayActor, ResellerGatewayService } from './reseller-gateway.service';

/**
 * A named reseller's gateways (F-066-w3, ADR-0064):
 * `/api/billing/tenants/:tenantId/gateways`, shaped exactly like
 * `/api/billing/gateways` so the panel's gateway components serve both
 * (F-066-w4). The ambient surface is untouched and stays what a tenant
 * configuring **itself** uses.
 *
 * **No `GatewayPermissionGuard`**, as on `tenant-service`'s reseller routes: a
 * reseller's owner holds no `gateway.manage` — they are a customer of the
 * platform, not one of its operators — and `ResellerAccess` is the door
 * instead. It admits the reseller's owner, one of its staff seats holding
 * `gateway.manage` (AC-1-e), and the platform owner's staff. What may then be done to a
 * gateway is `GatewayAdminService`'s, unchanged: the work runs as the reseller,
 * so a platform gateway is `gateway_not_found` here and `blockedReason` is
 * `block_is_platform_owners` for **everyone**, platform staff included —
 * blocking is done on the ambient route, as the platform owner (F-104-ak).
 *
 * Secrets behave as they do there: `merchantId`, `secretKey` and
 * `webhookSecret` go in, reach the vault through `tenant-service`, and appear
 * in no answer — `credentials` and `missingSecrets` are all that come back.
 */
@Controller('billing/tenants/:tenantId/gateways')
export class ResellerGatewayController {
  constructor(private readonly gateways: ResellerGatewayService) {}

  @Get()
  @RateLimit(READ)
  async list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.gateways.list(this.actor(req, ip), tenantId));
  }

  /** The reseller's own default quick amounts (F-092-v). Before `:source/:id` only for reading order. */
  @Get('presets')
  @RateLimit(READ)
  async presets(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.gateways.presets(this.actor(req, ip), tenantId));
  }

  @Put('presets')
  @RateLimit(WRITE)
  async setPresets(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(depositPresetsSchema)) body: DepositPresetsBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.gateways.setPresets(this.actor(req, ip), tenantId, body.presets ?? []));
  }

  /** The reseller's own default tax on a top-up (ADR-0076, F-104-ag). */
  @Get('tax')
  @RateLimit(READ)
  async tax(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return refusing(async () => ({ taxRatePercent: await this.gateways.tax(this.actor(req, ip), tenantId) }));
  }

  @Put('tax')
  @RateLimit(WRITE)
  async setTax(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(depositTaxSchema)) body: DepositTaxBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(async () => ({ taxRatePercent: await this.gateways.setTax(this.actor(req, ip), tenantId, body.taxRatePercent) }));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async create(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(createResellerGatewaySchema)) body: CreateResellerGatewayBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The schema requires `source`; the cast is for this project's non-strict
    // tsconfig, under which zod infers every key as optional.
    return refusing(() => this.gateways.create(this.actor(req, ip), tenantId, body as ResellerCreateGatewayInput));
  }

  @Patch(':source/:id')
  @RateLimit(WRITE)
  async update(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateGatewaySchema)) body: UpdateGatewayBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.gateways.update(this.actor(req, ip), tenantId, { source: gatewaySource(source), id }, body));
  }

  /** Who it is offered to (F-102-g): this reseller's user groups, replaced whole; `[]` = everyone. */
  @Put(':source/:id/audience')
  @RateLimit(WRITE)
  async setAudience(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(gatewayAudienceSchema)) body: GatewayAudienceBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() =>
      this.gateways.setAudience(this.actor(req, ip), tenantId, { source: gatewaySource(source), id }, body.userGroupIds),
    );
  }

  @Delete(':source/:id')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async remove(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.gateways.remove(this.actor(req, ip), tenantId, { source: gatewaySource(source), id }));
  }

  /** Who is asking, as the gate proved them. The reseller they are asking about is the path's. */
  private actor(req: Request, ip: string): ResellerGatewayActor {
    const { userId, tenantId, permissions } = identityOf(req);
    return { userId, tenantId, permissions, ip };
  }
}
