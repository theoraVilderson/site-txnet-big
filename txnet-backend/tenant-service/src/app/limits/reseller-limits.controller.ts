import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ResellerAccessRefused, type ResellerAccessRejection } from '@txnet-backend/shared-core';

import { identityOf } from '../request/identity.middleware';
import { TenantPermissionGuard } from '../request/tenant-permission.guard';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import {
  ClearResellersLimitInput,
  clearResellersLimitSchema,
  SetLimitInput,
  setLimitSchema,
  SetOverageCapInput,
  setOverageCapSchema,
  SetPackageProductInput,
  setPackageProductSchema,
  SetOverageInput,
  setOverageSchema,
  SetResellersLimitInput,
  setResellersLimitSchema,
  SetResellersOverageInput,
  setResellersOverageSchema,
} from './reseller-limits.schema';
import { PackageProductsService, PackageProductView } from './package-products.service';
import { LimitInEffectRow, LimitRow, OverageCapView, ProductQuotaInEffectRow, ResellerLimitsActor, ResellerLimitsRefused, ResellerLimitsRejection, ResellerLimitsService } from './reseller-limits.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerLimitsRejection, 403 | 404 | 422> = {
  not_platform_owner: 403,
  unknown_limit: 404,
  package_not_found: 404,
  reseller_not_found: 404,
  limit_out_of_range: 422,
  not_a_quota: 422,
  product_not_found: 404,
};

/**
 * Reseller limits, the platform owner's (F-019-m, ADR-0106), under
 * `/api/tenants/limits/…` — three segments or more, so nothing here is read
 * as `GET /api/tenants/:id`:
 *
 *  - `GET  settings` — every key, every level that sets it;
 *  - `PUT|DELETE settings/:key` — the platform's value (`DELETE`: the code default);
 *  - `PUT|DELETE packages/:packageId/:key` — a package's;
 *  - `PUT resellers/:key`, `POST resellers/:key/clear` — one or several
 *    resellers' own, `{tenantIds, value, reason}` / `{tenantIds}`;
 *  - the same four places + `/overage` — past a quota key, `{mode: 'stop'}`
 *    or `{mode: 'overage', unitPrice}` (ADR-0107 point 2); a guard key is
 *    `422 not_a_quota`.
 *
 * `value` null is no limit. Writes answer `204`; the table is read again.
 */
@Controller('tenants/limits')
@UseGuards(TenantPermissionGuard)
export class ResellerLimitsController {
  constructor(private readonly limits: ResellerLimitsService) {}

  @Get('settings')
  table(@Req() req: Request, @Ip() ip: string): Promise<LimitRow[]> {
    return this.refusing(() => this.limits.table(actorOf(req, ip)));
  }

  @Put('settings/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  setPlatform(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(setLimitSchema)) body: SetLimitInput) {
    return this.refusing(() => this.limits.setPlatform(actorOf(req, ip), key, body.value));
  }

  @Delete('settings/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearPlatform(@Req() req: Request, @Ip() ip: string, @Param('key') key: string) {
    return this.refusing(() => this.limits.clearPlatform(actorOf(req, ip), key));
  }

  @Put('packages/:packageId/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  setPackage(
    @Req() req: Request,
    @Ip() ip: string,
    @Param('packageId', new ParseUUIDPipe()) packageId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(setLimitSchema)) body: SetLimitInput,
  ) {
    return this.refusing(() => this.limits.setPackage(actorOf(req, ip), packageId, key, body.value));
  }

  @Delete('packages/:packageId/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearPackage(@Req() req: Request, @Ip() ip: string, @Param('packageId', new ParseUUIDPipe()) packageId: string, @Param('key') key: string) {
    return this.refusing(() => this.limits.clearPackage(actorOf(req, ip), packageId, key));
  }

  @Put('resellers/:key')
  setResellers(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(setResellersLimitSchema)) body: SetResellersLimitInput) {
    return this.refusing(() => this.limits.setResellers(actorOf(req, ip), key, body.tenantIds, body.value, body.reason));
  }

  @Post('resellers/:key/clear')
  @HttpCode(HttpStatus.OK)
  clearResellers(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(clearResellersLimitSchema)) body: ClearResellersLimitInput) {
    return this.refusing(() => this.limits.clearResellers(actorOf(req, ip), key, body.tenantIds));
  }

  @Put('settings/:key/overage')
  @HttpCode(HttpStatus.NO_CONTENT)
  setPlatformOverage(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(setOverageSchema)) body: SetOverageInput) {
    return this.refusing(() => this.limits.setPlatformOverage(actorOf(req, ip), key, body));
  }

  @Delete('settings/:key/overage')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearPlatformOverage(@Req() req: Request, @Ip() ip: string, @Param('key') key: string) {
    return this.refusing(() => this.limits.clearPlatformOverage(actorOf(req, ip), key));
  }

  @Put('packages/:packageId/:key/overage')
  @HttpCode(HttpStatus.NO_CONTENT)
  setPackageOverage(
    @Req() req: Request,
    @Ip() ip: string,
    @Param('packageId', new ParseUUIDPipe()) packageId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(setOverageSchema)) body: SetOverageInput,
  ) {
    return this.refusing(() => this.limits.setPackageOverage(actorOf(req, ip), packageId, key, body));
  }

  @Delete('packages/:packageId/:key/overage')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearPackageOverage(@Req() req: Request, @Ip() ip: string, @Param('packageId', new ParseUUIDPipe()) packageId: string, @Param('key') key: string) {
    return this.refusing(() => this.limits.clearPackageOverage(actorOf(req, ip), packageId, key));
  }

  @Put('resellers/:key/overage')
  setResellersOverage(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(setResellersOverageSchema)) body: SetResellersOverageInput) {
    const input: SetOverageInput = body.mode === 'stop' ? { mode: 'stop' } : { mode: 'overage', unitPrice: body.unitPrice };
    return this.refusing(() => this.limits.setResellersOverage(actorOf(req, ip), key, body.tenantIds, input, body.reason));
  }

  @Post('resellers/:key/overage/clear')
  @HttpCode(HttpStatus.OK)
  clearResellersOverage(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(clearResellersLimitSchema)) body: ClearResellersLimitInput) {
    return this.refusing(() => this.limits.clearResellersOverage(actorOf(req, ip), key, body.tenantIds));
  }

  private refusing<T>(work: () => Promise<T>): Promise<T> {
    return refusing(work);
  }
}

/** `ResellerAccess`'s refusals; `read` still admits a suspended reseller. */
const ACCESS_STATUS: Record<ResellerAccessRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
};

/**
 * One reseller's limits in effect, where each comes from and how much is used
 * (F-019-r, F-019-s): `GET /api/tenants/:id/limits`. No `TenantPermissionGuard`:
 * the reseller's owner holds no `tenant.manage` and is let in by
 * `ResellerAccess`, as its team and the platform's staff are.
 */
@Controller('tenants/:id/limits')
export class ResellerLimitsOfController {
  constructor(private readonly limits: ResellerLimitsService) {}

  @Get()
  ofReseller(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<LimitInEffectRow[]> {
    return admitting(() => this.limits.ofReseller(identityOf(req), id));
  }

  /** The platform products it sells and each one's sales quota statement, per window (F-019-v10). */
  @Get('products')
  products(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<ProductQuotaInEffectRow[]> {
    return admitting(() => this.limits.productsOf(identityOf(req), id));
  }

  /** The reseller's own overage cap and this month's spend (F-019-v2). */
  @Get('overage-cap')
  overageCap(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<OverageCapView> {
    return admitting(() => this.limits.overageCapOf(identityOf(req), id));
  }

  /** `{amount: "50.00"}` sets it, `{amount: null}` removes it; answers the cap and the spend. */
  @Put('overage-cap')
  setOverageCap(@Req() req: Request, @Ip() ip: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(setOverageCapSchema)) body: SetOverageCapInput) {
    return admitting(() => this.limits.setOverageCap({ ...identityOf(req), ip }, id, body.amount));
  }
}

/**
 * The platform products a package lets its subscribers sell (F-019-v5,
 * ADR-0107 point 3): `GET` the list with each one's sales quota, `PUT
 * …/:productId` `{day?, week?, month?, overage?}` lists one with its quota
 * (F-019-v6; `{}` = none), `DELETE` takes it off. A product that is not the
 * platform's is `404 product_not_found`. Writes answer `204`.
 */
@Controller('tenants/limits/packages/:packageId/products')
@UseGuards(TenantPermissionGuard)
export class PackageProductsController {
  constructor(private readonly products: PackageProductsService) {}

  @Get()
  list(@Req() req: Request, @Ip() ip: string, @Param('packageId', new ParseUUIDPipe()) packageId: string): Promise<PackageProductView[]> {
    return refusing(() => this.products.list(actorOf(req, ip), packageId));
  }

  @Put(':productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  set(
    @Req() req: Request,
    @Ip() ip: string,
    @Param('packageId', new ParseUUIDPipe()) packageId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body(new ZodValidationPipe(setPackageProductSchema)) body: SetPackageProductInput,
  ) {
    return refusing(() => this.products.set(actorOf(req, ip), packageId, productId, body));
  }

  @Delete(':productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  clear(@Req() req: Request, @Ip() ip: string, @Param('packageId', new ParseUUIDPipe()) packageId: string, @Param('productId', new ParseUUIDPipe()) productId: string) {
    return refusing(() => this.products.clear(actorOf(req, ip), packageId, productId));
  }
}

async function admitting<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof ResellerAccessRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    switch (ACCESS_STATUS[e.reason]) {
      case 403:
        throw new ForbiddenException(payload);
      case 404:
        throw new NotFoundException(payload);
      default:
        throw new ConflictException(payload);
    }
  }
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof ResellerLimitsRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    switch (STATUS[e.reason]) {
      case 403:
        throw new ForbiddenException(payload);
      case 404:
        throw new NotFoundException(payload);
      default:
        throw new UnprocessableEntityException(payload);
    }
  }
}

function actorOf(req: Request, ip: string): ResellerLimitsActor {
  const { userId, tenantId } = identityOf(req);
  return { adminId: userId, tenantId, ip };
}
