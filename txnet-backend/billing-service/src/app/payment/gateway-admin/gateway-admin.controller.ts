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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GATEWAY_ADMIN_READ as READ, GATEWAY_ADMIN_WRITE as WRITE } from './gateway-admin.rate-limit';
import {
  CreateGatewayBody,
  DepositPresetsBody,
  DepositTaxBody,
  GatewayAudienceBody,
  ListGatewaysQuery,
  UpdateGatewayBody,
  createGatewaySchema,
  depositPresetsSchema,
  depositTaxSchema,
  gatewayAudienceSchema,
  listGatewaysSchema,
  updateGatewaySchema,
} from './gateway-admin.schema';
import { gatewaySource, refusing } from './gateway-admin.http';
import { CreateGatewayInput, GatewayActor, GatewayAdminService } from './gateway-admin.service';
import { GatewayPermissionGuard } from './gateway-permission.guard';

/**
 * Gateway management (F-102-c, D-31): `/api/billing/gateways`.
 *
 * One surface for two audiences, told apart by the tenant, never by the path
 * (F-098): the platform owner sees and manages every gateway, any other tenant
 * only its own. `GatewayPermissionGuard` is the first door and
 * `GatewayAdminService` the real one. Linking a gateway to another tenant is
 * not here; it is `/api/billing/settlement/grants` (ADR-0041).
 *
 * **A secret goes in and never comes out.** `merchantId`, `secretKey` and
 * `webhookSecret` are accepted on create and update and relayed to
 * `auth-service` (F-102-a, F-104-c); every answer carries `credentials` as
 * `{configured, version, rotatedAt}` per secret, and `missingSecrets` naming
 * what the provider still needs (F-104-e), and nothing more. There is no route that
 * reads one back — to change a secret is to send a new one.
 *
 * A gateway is addressed as `:source/:id` because the two tables can share an
 * id and only the pair names a row (D-25).
 */
@Controller('billing/gateways')
@UseGuards(GatewayPermissionGuard)
export class GatewayAdminController {
  constructor(private readonly gateways: GatewayAdminService) {}

  private actor(req: Request, ip: string): GatewayActor {
    const { userId, tenantId, permissions } = identityOf(req);
    return { adminId: userId, tenantId, ip, permissions };
  }

  @Get()
  @RateLimit(READ)
  async list(@Query(new ZodValidationPipe(listGatewaysSchema)) query: ListGatewaysQuery, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.gateways.list(this.actor(req, ip), { tenantId: query.tenantId }));
  }

  /**
   * The caller's default quick amounts on the top-up page (F-092-v). Declared
   * before `:source/:id` only for reading order — one segment never matches two.
   */
  @Get('presets')
  @RateLimit(READ)
  async presets(@Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.gateways.presets(this.actor(req, ip)));
  }

  @Put('presets')
  @RateLimit(WRITE)
  async setPresets(@Body(new ZodValidationPipe(depositPresetsSchema)) body: DepositPresetsBody, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.gateways.setPresets(this.actor(req, ip), body.presets ?? []));
  }

  /** The caller's default tax on a top-up (ADR-0076, F-104-ag); a gateway's own rate overrides it, `null` is none. */
  @Get('tax')
  @RateLimit(READ)
  async tax(@Req() req: Request, @Ip() ip: string) {
    return refusing(async () => ({ taxRatePercent: await this.gateways.tax(this.actor(req, ip)) }));
  }

  @Put('tax')
  @RateLimit(WRITE)
  async setTax(@Body(new ZodValidationPipe(depositTaxSchema)) body: DepositTaxBody, @Req() req: Request, @Ip() ip: string) {
    return refusing(async () => ({ taxRatePercent: await this.gateways.setTax(this.actor(req, ip), body.taxRatePercent) }));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async create(@Body(new ZodValidationPipe(createGatewaySchema)) body: CreateGatewayBody, @Req() req: Request, @Ip() ip: string) {
    // The schema requires `source`; the cast is for this project's non-strict
    // tsconfig, under which zod infers every key as optional.
    return refusing(() => this.gateways.create(this.actor(req, ip), body as CreateGatewayInput));
  }

  @Patch(':source/:id')
  @RateLimit(WRITE)
  async update(
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateGatewaySchema)) body: UpdateGatewayBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.gateways.update(this.actor(req, ip), { source: gatewaySource(source), id }, body));
  }

  /**
   * A real `DELETE`, unlike a grant's withdrawal: the answer's `mode` says
   * whether the row is gone or, because a payment or a grant points at it, was
   * deactivated instead (ADR-0041 §6).
   */
  /** Who it is offered to (F-102-g): the owner's user groups, replaced whole; `[]` = everyone. */
  @Put(':source/:id/audience')
  @RateLimit(WRITE)
  async setAudience(
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(gatewayAudienceSchema)) body: GatewayAudienceBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.gateways.setAudience(this.actor(req, ip), { source: gatewaySource(source), id }, body.userGroupIds));
  }

  @Delete(':source/:id')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async remove(@Param('source') source: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.gateways.remove(this.actor(req, ip), { source: gatewaySource(source), id }));
  }
}
