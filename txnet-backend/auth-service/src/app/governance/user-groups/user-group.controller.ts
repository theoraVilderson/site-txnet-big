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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, ResellerLimitReached, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthGuard } from '../../auth/auth.guard';
import { RateLimit } from '../../auth/decorators/rate-limit.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { AuthClaims } from '../../auth/token.service';
import { UserGroupRejection } from './user-group';
import {
  UserGroupActor,
  UserGroupAdminService,
  UserGroupInput,
  UserGroupRefused,
} from './user-group-admin.service';
import {
  AddUserGroupMembersBody,
  CreateUserGroupBody,
  SetUserGroupAccessBody,
  UpdateUserGroupBody,
  UserGroupMemberPageQuery,
  addUserGroupMembersSchema,
  createUserGroupSchema,
  setUserGroupAccessSchema,
  updateUserGroupSchema,
  userGroupMemberPageSchema,
} from './user-group.schema';

/** The permission user-group management needs (F-114-j). SuperAdmin holds it as `*`. */
export const USER_GROUP_MANAGE = 'user_group.manage';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const USER_GROUP_REFUSAL_STATUS: Record<UserGroupRejection, 400 | 403 | 404 | 409> = {
  group_not_found: 404,
  member_not_found: 404,
  user_not_found: 404,
  tenant_not_found: 404,
  platform_only: 403,
  not_a_reseller: 400,
  name_taken: 409,
  all_tenants_conflict: 409,
  group_in_use: 409,
  access_on_resellers: 409,
  role_not_found: 404,
  key_unknown: 400,
  key_not_grantable: 403,
  key_not_held: 403,
  no_authority: 403,
};

const READ = {
  key: (req: Request & { user?: AuthClaims }) => rateLimitBucketKey(RateLimitBucket.USER_GROUP_READ, req?.user?.sub ?? req?.ip),
  configKey: 'USER_GROUP_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request & { user?: AuthClaims }) => rateLimitBucketKey(RateLimitBucket.USER_GROUP_WRITE, req?.user?.sub ?? req?.ip),
  configKey: 'USER_GROUP_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * User groups (F-114-j, governance): `/api/auth/user-groups`. Owned by
 * `governance`, served here beside the users it groups.
 *
 * Behind `user_group.manage`, and confined to the caller's own tenant by RLS
 * (`UserGroupAdminService`). The platform owner's groups are its own tenant's
 * too; only they may name a reseller, another tenant's user, or every reseller.
 * A member is removed by `DELETE` of its row — a user and a reseller each
 * have their own path, so neither id can be read as the other.
 */
@Controller('auth/user-groups')
@UseGuards(AuthGuard, new PermissionsGuard([USER_GROUP_MANAGE]))
export class UserGroupController {
  constructor(private readonly groups: UserGroupAdminService) {}

  @Get()
  @RateLimit(READ)
  list(@Req() req: Request) {
    return this.refusing(() => this.groups.list(this.actor(req)));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  create(@Body(new ZodValidationPipe(createUserGroupSchema)) body: CreateUserGroupBody, @Req() req: Request) {
    // The schema requires `name`; the cast is for this project's non-strict
    // tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.groups.create(this.actor(req), body as UserGroupInput));
  }

  @Patch(':id')
  @RateLimit(WRITE)
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(updateUserGroupSchema)) body: UpdateUserGroupBody, @Req() req: Request) {
    return this.refusing(() => this.groups.update(this.actor(req), id, body));
  }

  @Delete(':id')
  @RateLimit(WRITE)
  remove(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.refusing(() => this.groups.remove(this.actor(req), id));
  }

  @Get(':id/members')
  @RateLimit(READ)
  members(@Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodValidationPipe(userGroupMemberPageSchema)) query: UserGroupMemberPageQuery, @Req() req: Request) {
    const q = query as Required<UserGroupMemberPageQuery>;
    return this.refusing(() => this.groups.members(this.actor(req), id, q.page, q.pageSize));
  }

  /** What the group gives its user members: a role and/or keys, the whole set (AC-1-m, ADR-0138). */
  @Put(':id/access')
  @RateLimit(WRITE)
  setAccess(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(setUserGroupAccessSchema)) body: SetUserGroupAccessBody, @Req() req: Request) {
    return this.refusing(() => this.groups.setAccess(this.actor(req), id, body));
  }

  @Post(':id/members')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  addMembers(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(addUserGroupMembersSchema)) body: AddUserGroupMembersBody, @Req() req: Request) {
    return this.refusing(() => this.groups.addMembers(this.actor(req), id, body));
  }

  @Delete(':id/members/users/:userId')
  @RateLimit(WRITE)
  removeUser(@Param('id', new ParseUUIDPipe()) id: string, @Param('userId', new ParseUUIDPipe()) userId: string, @Req() req: Request) {
    return this.refusing(() => this.groups.removeMember(this.actor(req), id, { userId }));
  }

  @Delete(':id/members/tenants/:tenantId')
  @RateLimit(WRITE)
  removeTenant(@Param('id', new ParseUUIDPipe()) id: string, @Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.groups.removeMember(this.actor(req), id, { tenantId }));
  }

  /** The caller, as `AuthGuard` left them on the request. */
  private actor(req: Request): UserGroupActor {
    const user = (req as Request & { user: AuthClaims }).user;
    // `admin_audit_log.adminIpAddress` is `NOT NULL`; an unresolvable peer is recorded as such.
    return { adminId: user.sub, tenantId: user.tenantId, ip: req.ip ?? '0.0.0.0', permissions: user.permissions };
  }

  /** One refusal type in, one HTTP status out — the reason travels as the body's `reason`. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      // Past the reseller's staff_members_max (GR-1-b): the figures say what to raise.
      if (err instanceof ResellerLimitReached) throw new ConflictException({ reason: err.reason, message: err.message, facts: err.facts });
      if (!(err instanceof UserGroupRefused)) throw err;
      const body = { reason: err.reason, message: err.message };
      switch (USER_GROUP_REFUSAL_STATUS[err.reason]) {
        case 403:
          throw new ForbiddenException(body);
        case 404:
          throw new NotFoundException(body);
        case 409:
          throw new ConflictException(body);
        default:
          throw new BadRequestException(body);
      }
    }
  }
}
