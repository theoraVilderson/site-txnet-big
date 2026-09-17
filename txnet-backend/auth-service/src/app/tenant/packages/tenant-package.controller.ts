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
import { AuthGuard } from '../../auth/auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PermissionsGuard } from '../../impersonation/guards/permissions.guard';
import { TENANT_MANAGE } from '../admin/tenant-admin.controller';
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

type ClaimsRequest = { user: { sub: string; tenantId: string } };

/**
 * The packages the platform sells resellers (F-018-d):
 * `POST|GET /api/auth/tenant-packages`, `GET|PATCH /api/auth/tenant-packages/:id`,
 * and `POST /api/auth/tenant-packages/:id/apply` (F-018-o).
 * No DELETE — a package is deactivated with `PATCH {isActive: false}`.
 */
@Controller('auth/tenant-packages')
@UseGuards(AuthGuard, new PermissionsGuard([TENANT_MANAGE]))
export class TenantPackageController {
  constructor(private readonly packages: TenantPackageService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: ClaimsRequest,
    @Body(new ZodValidationPipe(createPackageSchema)) body: CreatePackageInput,
    @Ip() ip: string,
  ): Promise<PackageView> {
    return this.refusing(() => this.packages.create(actorOf(req, ip), body));
  }

  @Get()
  async list(
    @Req() req: ClaimsRequest,
    @Query(new ZodValidationPipe(listPackagesSchema)) query: ListPackagesInput,
    @Ip() ip: string,
  ): Promise<PackageView[]> {
    return this.refusing(() => this.packages.list(actorOf(req, ip), query));
  }

  @Get(':id')
  async read(@Req() req: ClaimsRequest, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<PackageView> {
    return this.refusing(() => this.packages.read(actorOf(req, ip), id));
  }

  /** Forces the package's feature list onto every current subscriber now, removals included (F-018-o). */
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  async apply(@Req() req: ClaimsRequest, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<PackageApplyView> {
    return this.refusing(() => this.packages.apply(actorOf(req, ip), id));
  }

  @Patch(':id')
  async update(
    @Req() req: ClaimsRequest,
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

function actorOf(req: ClaimsRequest, ip: string): TenantPackageActor {
  return { adminId: req.user.sub, tenantId: req.user.tenantId, ip };
}
