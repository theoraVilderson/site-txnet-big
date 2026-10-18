import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, accessTraceOf, rateLimitBucketKey, ZodValidationPipe } from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../auth.guard';
import { RateLimit, type RateLimitOptions } from '../decorators/rate-limit.decorator';
import type { AuthClaims } from '../token.service';
import {
  assignRoleSchema,
  createRoleSchema,
  keyParamSchema,
  setKeySchema,
  updateRoleSchema,
  type AssignRoleInput,
  type CreateRoleInput,
  type SetKeyInput,
  type UpdateRoleInput,
} from './role.schema';
import { TenantRolesRefused, TenantRolesRejection, TenantRolesService } from './tenant-roles.service';

/** Every refusal of either door gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<TenantRolesRejection, 400 | 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  consent_required: 403,
  consent_read_only: 403,
  user_not_found: 404,
  role_not_found: 404,
  role_not_held: 403,
  no_authority: 403,
  key_unknown: 400,
  key_not_grantable: 403,
  key_not_held: 403,
  key_on_wildcard: 409,
  superadmin_limit: 409,
  key_not_found: 404,
  window_on_take: 400,
  window_past: 400,
  window_inverted: 400,
};

/** An act on a person, so it spends the users-admin's per-caller budget, as block does. */
const PERSON_WRITE: RateLimitOptions = {
  key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_WRITE, req?.user?.sub ?? req?.ip),
  configKey: 'RESELLER_USER_WRITE_RATE_LIMIT',
  windowSec: 900,
};

/** A role write is the tenant's, so its budget is the path's tenant (as `ROLE_WRITE` on `/auth/roles`). */
const ROLE_WRITE: RateLimitOptions = {
  key: (req) => rateLimitBucketKey(RateLimitBucket.ROLE_WRITE, req?.params?.tenantId ?? req?.ip),
  configKey: 'ROLE_WRITE_RATE_LIMIT',
  windowSec: 900,
};

/**
 * A tenant's roles, and the role one of its people holds, on the tenant's own
 * path (F-1201-a, ADR-0134). `/auth/roles` stays for the caller's own tenant;
 * this is the surface a reseller's owner — a user of the platform's tenant
 * (ADR-0059) — can reach their reseller by, and the platform's staff theirs.
 *
 * **No `PermissionsGuard`**, as on every reseller-named surface:
 * `ResellerAccess` is the door, inside the service. Role-level refusals
 * (`role.nameTaken`, `role.permissionNotHeld`, ...) are `RolesService`'s own
 * and pass through unchanged.
 */
@Controller('auth/tenants/:tenantId')
@UseGuards(AuthGuard)
export class TenantRolesController {
  constructor(private readonly roles: TenantRolesService) {}

  @Get('roles')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_READ, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_USER_READ_RATE_LIMIT',
    windowSec: 900,
  })
  list(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.roles.list(actorOf(req), tenantId));
  }

  @Post('roles')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(ROLE_WRITE)
  create(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleInput,
  ) {
    return this.refusing(() => this.roles.create(actorOf(req), tenantId, body));
  }

  @Patch('roles/:id')
  @RateLimit(ROLE_WRITE)
  update(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleInput,
  ) {
    return this.refusing(() => this.roles.update(actorOf(req), tenantId, id, body, req.ip ?? '0.0.0.0'));
  }

  @Delete('roles/:id')
  @RateLimit(ROLE_WRITE)
  remove(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.refusing(() => this.roles.remove(actorOf(req), tenantId, id));
  }

  @Put('users/:userId/role')
  @RateLimit(PERSON_WRITE)
  assign(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(assignRoleSchema)) body: AssignRoleInput,
  ) {
    return this.refusing(() => this.roles.assign(actorOf(req), tenantId, userId, body.roleId, req.ip ?? '0.0.0.0'));
  }

  /** A person's keys by source — role, given, taken — and their answer (AC-1-l). */
  @Get('users/:userId/keys')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_READ, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_USER_READ_RATE_LIMIT',
    windowSec: 900,
  })
  keysOf(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    return this.refusing(() => this.roles.keysOf(actorOf(req), tenantId, userId));
  }

  /** Give or take one key on one person, with a reason (AC-1-l, ADR-0138). */
  @Put('users/:userId/keys/:key')
  @RateLimit(PERSON_WRITE)
  setKey(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('key', new ZodValidationPipe(keyParamSchema)) key: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(setKeySchema)) body: SetKeyInput,
  ) {
    return this.refusing(() => this.roles.setKey(actorOf(req), tenantId, userId, key, body, req.ip ?? '0.0.0.0'));
  }

  /** Lift a key given or taken: the role decides it again (AC-1-l). */
  @Delete('users/:userId/keys/:key')
  @RateLimit(PERSON_WRITE)
  liftKey(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('key', new ZodValidationPipe(keyParamSchema)) key: string,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.roles.liftKey(actorOf(req), tenantId, userId, key, req.ip ?? '0.0.0.0'));
  }

  /** One refusal type in, one HTTP status out — the reason travels as the body's `reason`. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof TenantRolesRefused)) throw err;
      const body = { reason: err.reason };
      switch (STATUS[err.reason]) {
        case 400:
          throw new BadRequestException(body);
        case 403:
          throw new ForbiddenException(body);
        case 404:
          throw new NotFoundException(body);
        default:
          throw new ConflictException(body);
      }
    }
  }
}

/** The caller, as `AuthGuard` left them, with the request the door records for staff (F-117-c). */
function actorOf(req: Request) {
  const user = (req as Request & { user: AuthClaims }).user;
  return { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions, trace: accessTraceOf(req) };
}
