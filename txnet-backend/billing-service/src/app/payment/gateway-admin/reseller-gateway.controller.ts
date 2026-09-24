import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  NotFoundException,
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
import type { GatewaySource } from '../gateway/gateway-merchant';
import { GATEWAY_ADMIN_READ as READ, GATEWAY_ADMIN_WRITE as WRITE } from './gateway-admin.rate-limit';
import {
  CreateResellerGatewayBody,
  DepositPresetsBody,
  DepositTaxBody,
  UpdateGatewayBody,
  createResellerGatewaySchema,
  depositPresetsSchema,
  depositTaxSchema,
  updateGatewaySchema,
} from './gateway-admin.schema';
import {
  ResellerCreateGatewayInput,
  ResellerGatewayActor,
  ResellerGatewayRefused,
  ResellerGatewayRejection,
  ResellerGatewayService,
} from './reseller-gateway.service';
import { GatewaySecretsRefused, GatewaySecretsUnavailable } from './vault-secret.client';

/** Every refusal of either door gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerGatewayRejection, 400 | 403 | 404 | 409> = {
  // ResellerAccess (invariant 21): who may configure this reseller.
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  // GatewayAdminService: what may be done to a gateway. The same statuses the
  // ambient surface answers, so one client reads both.
  not_platform_owner: 403,
  verification_is_platform_owners: 403,
  gateway_not_found: 404,
  tenant_not_found: 404,
  provider_already_configured: 409,
  gateway_has_open_payments: 409,
  invalid_range: 400,
  missing_field: 400,
  invalid_presets: 400,
  invalid_callback: 400,
};

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
 * `tenant.manage`, and the platform owner's staff. What may then be done to a
 * gateway is `GatewayAdminService`'s, unchanged: the work runs as the reseller,
 * so a platform gateway is `gateway_not_found` here and `verificationStatus` is
 * `verification_is_platform_owners` for **everyone**, platform staff included —
 * verifying is done on the ambient route, as the platform owner.
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
    return this.refusing(() => this.gateways.list(this.actor(req, ip), tenantId));
  }

  /** The reseller's own default quick amounts (F-092-v). Before `:source/:id` only for reading order. */
  @Get('presets')
  @RateLimit(READ)
  async presets(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(async () => ({ presets: await this.gateways.presets(this.actor(req, ip), tenantId) }));
  }

  @Put('presets')
  @RateLimit(WRITE)
  async setPresets(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(depositPresetsSchema)) body: DepositPresetsBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(async () => ({ presets: await this.gateways.setPresets(this.actor(req, ip), tenantId, body.presets ?? []) }));
  }

  /** The reseller's own default tax on a top-up (ADR-0076, F-104-ag). */
  @Get('tax')
  @RateLimit(READ)
  async tax(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(async () => ({ taxRatePercent: await this.gateways.tax(this.actor(req, ip), tenantId) }));
  }

  @Put('tax')
  @RateLimit(WRITE)
  async setTax(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(depositTaxSchema)) body: DepositTaxBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(async () => ({ taxRatePercent: await this.gateways.setTax(this.actor(req, ip), tenantId, body.taxRatePercent) }));
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
    return this.refusing(() => this.gateways.create(this.actor(req, ip), tenantId, body as ResellerCreateGatewayInput));
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
    return this.refusing(() => this.gateways.update(this.actor(req, ip), tenantId, { source: this.source(source), id }, body));
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
    return this.refusing(() => this.gateways.remove(this.actor(req, ip), tenantId, { source: this.source(source), id }));
  }

  /** Who is asking, as the gate proved them. The reseller they are asking about is the path's. */
  private actor(req: Request, ip: string): ResellerGatewayActor {
    const { userId, tenantId, permissions } = identityOf(req);
    return { userId, tenantId, permissions, ip };
  }

  private source(value: string): GatewaySource {
    if (value !== 'platform' && value !== 'tenant') throw new NotFoundException();
    return value;
  }

  /** One place that turns a refusal into a status — the ambient controller's, over both doors' reasons. */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof GatewaySecretsRefused) throw new HttpException({ reason: e.reason, message: e.message }, e.status);
      if (e instanceof GatewaySecretsUnavailable) throw new BadGatewayException({ reason: 'secrets_unavailable', message: 'the credential vault could not be reached' });
      if (!(e instanceof ResellerGatewayRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        case 409:
          throw new ConflictException(payload);
        default:
          throw new BadRequestException(payload);
      }
    }
  }
}
