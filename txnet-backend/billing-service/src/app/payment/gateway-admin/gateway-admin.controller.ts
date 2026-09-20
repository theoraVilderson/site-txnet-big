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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import type { GatewaySource } from '../gateway/gateway-merchant';
import { GATEWAY_ADMIN_READ as READ, GATEWAY_ADMIN_WRITE as WRITE } from './gateway-admin.rate-limit';
import {
  CreateGatewayBody,
  DepositPresetsBody,
  ListGatewaysQuery,
  UpdateGatewayBody,
  createGatewaySchema,
  depositPresetsSchema,
  listGatewaysSchema,
  updateGatewaySchema,
} from './gateway-admin.schema';
import {
  CreateGatewayInput,
  GatewayActor,
  GatewayAdminRefused,
  GatewayAdminRejection,
  GatewayAdminService,
} from './gateway-admin.service';
import { GatewayPermissionGuard } from './gateway-permission.guard';
import { GatewaySecretsRefused, GatewaySecretsUnavailable } from './vault-secret.client';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<GatewayAdminRejection, 400 | 403 | 404 | 409> = {
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
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId, ip };
  }

  @Get()
  @RateLimit(READ)
  async list(@Query(new ZodValidationPipe(listGatewaysSchema)) query: ListGatewaysQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.gateways.list(this.actor(req, ip), { tenantId: query.tenantId }));
  }

  /**
   * The caller's default quick amounts on the top-up page (F-092-v). Declared
   * before `:source/:id` only for reading order — one segment never matches two.
   */
  @Get('presets')
  @RateLimit(READ)
  async presets(@Req() req: Request, @Ip() ip: string) {
    return this.refusing(async () => ({ presets: await this.gateways.presets(this.actor(req, ip)) }));
  }

  @Put('presets')
  @RateLimit(WRITE)
  async setPresets(@Body(new ZodValidationPipe(depositPresetsSchema)) body: DepositPresetsBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(async () => ({ presets: await this.gateways.setPresets(this.actor(req, ip), body.presets ?? []) }));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async create(@Body(new ZodValidationPipe(createGatewaySchema)) body: CreateGatewayBody, @Req() req: Request, @Ip() ip: string) {
    // The schema requires `source`; the cast is for this project's non-strict
    // tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.gateways.create(this.actor(req, ip), body as CreateGatewayInput));
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
    return this.refusing(() => this.gateways.update(this.actor(req, ip), { source: this.source(source), id }, body));
  }

  /**
   * A real `DELETE`, unlike a grant's withdrawal: the answer's `mode` says
   * whether the row is gone or, because a payment or a grant points at it, was
   * deactivated instead (ADR-0041 §6).
   */
  @Delete(':source/:id')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async remove(@Param('source') source: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.gateways.remove(this.actor(req, ip), { source: this.source(source), id }));
  }

  private source(value: string): GatewaySource {
    if (value !== 'platform' && value !== 'tenant') throw new NotFoundException();
    return value;
  }

  /**
   * One place that turns a refusal into a status. The reason travels in the
   * body, as on the settlement surface: naming the rule is what the operator
   * needs. A vault seam that is down is a 502 with no detail — its message is
   * about the other process and is logged there, not shown here.
   */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof GatewaySecretsRefused) throw new HttpException({ reason: e.reason, message: e.message }, e.status);
      if (e instanceof GatewaySecretsUnavailable) throw new BadGatewayException({ reason: 'secrets_unavailable', message: 'the credential vault could not be reached' });
      if (!(e instanceof GatewayAdminRefused)) throw e;
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
