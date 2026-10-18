import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { BackendI18nKeys, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { PlatformPermissionGuard, PlatformRoute } from '../request/platform-permission.guard';
import { isPartRejection, type PackagePartRejection } from './package-parts';
import {
  CreatePackageInput,
  ListPackagesInput,
  UpdatePackageInput,
  createPackageSchema,
  listPackagesSchema,
  updatePackageSchema,
} from './tenant-package.schema';
import {
  PackageApplyView,
  PackageView,
  TenantPackageActor,
  TenantPackageRefused,
  TenantPackageRejection,
  TenantPackageService,
} from './tenant-package.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<TenantPackageRejection, 403 | 404 | 409 | 422 | 503> = {
  not_platform_owner: 403,
  package_not_found: 404,
  package_name_taken: 409,
  package_unpriced: 422,
  package_price_finer_than_currency: 422,
  package_price_in_use: 409,
  meter_not_found: 422,
  // A part of a create (ADR-0154 decision 4): the body is wrong, whatever the limits route says for a path.
  unknown_limit: 422,
  limit_out_of_range: 422,
  not_a_quota: 422,
  product_not_found: 422,
  amount_finer_than_currency: 422,
  // The name and description in locale-service (ADR-0154 decision 5).
  lang_unknown: 422,
  text_key_invalid: 422,
  texts_unavailable: 503,
};

/**
 * The packages the platform sells resellers (F-018-d):
 * `POST|GET /api/tenant-packages`, `GET|PATCH /api/tenant-packages/:id`,
 * and `POST /api/tenant-packages/:id/apply` (F-018-o).
 * No DELETE — a package is deactivated with `PATCH {isActive: false}`.
 *
 * Moved out of `auth-service` with F-018-u (ADR-0058), behaviour unchanged:
 * the path lost its `/auth` prefix, and the caller is whoever `forward-auth`
 * proved, not a token this service reads.
 */
@Controller('tenant-packages')
@UseGuards(PlatformPermissionGuard)
@PlatformRoute('platform.plan.assign')
export class TenantPackageController {
  constructor(private readonly packages: TenantPackageService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createPackageSchema)) body: CreatePackageInput,
    @Ip() ip: string,
  ): Promise<PackageView> {
    return refusing(() => this.packages.create(actorOf(req, ip), body));
  }

  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listPackagesSchema)) query: ListPackagesInput,
    @Ip() ip: string,
  ): Promise<PackageView[]> {
    return refusing(() => this.packages.list(actorOf(req, ip), query));
  }

  @Get(':id')
  async read(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<PackageView> {
    return refusing(() => this.packages.read(actorOf(req, ip), id));
  }

  /** Forces the package's feature list onto every current subscriber now, removals included (F-018-o). */
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  async apply(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<PackageApplyView> {
    return refusing(() => this.packages.apply(actorOf(req, ip), id));
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePackageSchema)) body: UpdatePackageInput,
    @Ip() ip: string,
  ): Promise<PackageView> {
    return refusing(() => this.packages.update(actorOf(req, ip), id, body));
  }
}

/** What the panel reads for a refused part of a create: the field, said in words — the envelope's `fieldErrors` (PK-1-j). */
const PART_TEXT: Record<PackagePartRejection, string> = {
  unknown_limit: BackendI18nKeys.errors.tenant.package.limitUnknown,
  limit_out_of_range: BackendI18nKeys.errors.tenant.package.limitOutOfRange,
  not_a_quota: BackendI18nKeys.errors.tenant.package.notAQuota,
  product_not_found: BackendI18nKeys.errors.tenant.package.productNotPlatforms,
  amount_finer_than_currency: BackendI18nKeys.errors.tenant.package.priceFinerThanCurrency,
};

/** A package refusal as its HTTP answer, `reason` beside any `fieldErrors`; anything else is rethrown. */
export async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof TenantPackageRefused)) throw e;
    const payload = { reason: e.reason, message: e.message, ...fieldOf(e) };
    switch (STATUS[e.reason]) {
      case 403:
        throw new ForbiddenException(payload);
      case 404:
        throw new NotFoundException(payload);
      case 409:
        throw new ConflictException(payload);
      case 503:
        throw new ServiceUnavailableException(payload);
      default:
        throw new UnprocessableEntityException(payload);
    }
  }
}

function fieldOf(e: TenantPackageRefused): { fieldErrors?: { path: string; i18nKey: string }[] } {
  if (!e.field || !isPartRejection(e.reason)) return {};
  return { fieldErrors: [{ path: e.field, i18nKey: PART_TEXT[e.reason] }] };
}

export function actorOf(req: Request, ip: string): TenantPackageActor {
  const identity = identityOf(req);
  return { adminId: identity.userId, tenantId: identity.tenantId, ip };
}
