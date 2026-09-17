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
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { TenantPermissionGuard } from '../request/tenant-permission.guard';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
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
const STATUS: Record<TenantPackageRejection, 403 | 404 | 409 | 422> = {
  not_platform_owner: 403,
  package_not_found: 404,
  package_name_taken: 409,
  package_unpriced: 422,
  package_price_in_use: 409,
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
@UseGuards(TenantPermissionGuard)
export class TenantPackageController {
  constructor(private readonly packages: TenantPackageService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createPackageSchema)) body: CreatePackageInput,
    @Ip() ip: string,
  ): Promise<PackageView> {
    return this.refusing(() => this.packages.create(actorOf(req, ip), body));
  }

  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listPackagesSchema)) query: ListPackagesInput,
    @Ip() ip: string,
  ): Promise<PackageView[]> {
    return this.refusing(() => this.packages.list(actorOf(req, ip), query));
  }

  @Get(':id')
  async read(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<PackageView> {
    return this.refusing(() => this.packages.read(actorOf(req, ip), id));
  }

  /** Forces the package's feature list onto every current subscriber now, removals included (F-018-o). */
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  async apply(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<PackageApplyView> {
    return this.refusing(() => this.packages.apply(actorOf(req, ip), id));
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePackageSchema)) body: UpdatePackageInput,
    @Ip() ip: string,
  ): Promise<PackageView> {
    return this.refusing(() => this.packages.update(actorOf(req, ip), id, body));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (!(e instanceof TenantPackageRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        case 409:
          throw new ConflictException(payload);
        default:
          throw new UnprocessableEntityException(payload);
      }
    }
  }
}

function actorOf(req: Request, ip: string): TenantPackageActor {
  const identity = identityOf(req);
  return { adminId: identity.userId, tenantId: identity.tenantId, ip };
}
