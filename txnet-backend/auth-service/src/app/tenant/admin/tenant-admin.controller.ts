import {
  BadRequestException,
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
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PasswordContainsProfileDataError } from '../../common/validation/strong-password.schema';
import { PermissionsGuard } from '../../impersonation/guards/permissions.guard';
import {
  CreateResellerInput,
  ListResellersInput,
  createResellerSchema,
  listResellersSchema,
} from './tenant-admin.schema';
import {
  ResellerView,
  TenantAdminActor,
  TenantAdminRefused,
  TenantAdminRejection,
  TenantAdminService,
} from './tenant-admin.service';

/** The permission reseller administration needs; the service admits only the platform owner's. */
export const TENANT_MANAGE = 'tenant.manage';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<TenantAdminRejection, 403 | 404 | 409> = {
  not_platform_owner: 403,
  reseller_not_found: 404,
  slug_taken: 409,
};

type ClaimsRequest = { user: { sub: string; tenantId: string } };

/**
 * The platform owner's reseller administration (F-018-c):
 * `POST /api/auth/tenants`, `GET /api/auth/tenants`, `GET /api/auth/tenants/:id`.
 *
 * Mounted under `/auth` because `auth-service` hosts the tenant unit's code;
 * a role word never belongs in the path (F-099).
 */
@Controller('auth/tenants')
@UseGuards(AuthGuard, new PermissionsGuard([TENANT_MANAGE]))
export class TenantAdminController {
  constructor(private readonly tenants: TenantAdminService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: ClaimsRequest,
    @Body(new ZodValidationPipe(createResellerSchema)) body: CreateResellerInput,
    @Ip() ip: string,
  ): Promise<ResellerView> {
    return this.refusing(() => this.tenants.create(actorOf(req, ip), body));
  }

  @Get()
  async list(
    @Req() req: ClaimsRequest,
    @Query(new ZodValidationPipe(listResellersSchema)) page: ListResellersInput,
    @Ip() ip: string,
  ): Promise<ResellerView[]> {
    return this.refusing(() => this.tenants.list(actorOf(req, ip), page));
  }

  @Get(':id')
  async read(
    @Req() req: ClaimsRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Ip() ip: string,
  ): Promise<ResellerView> {
    return this.refusing(() => this.tenants.read(actorOf(req, ip), id));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof PasswordContainsProfileDataError) throw new BadRequestException(e.i18nKey);
      if (!(e instanceof TenantAdminRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        default:
          throw new ConflictException(payload);
      }
    }
  }
}

function actorOf(req: ClaimsRequest, ip: string): TenantAdminActor {
  return { adminId: req.user.sub, tenantId: req.user.tenantId, ip };
}
