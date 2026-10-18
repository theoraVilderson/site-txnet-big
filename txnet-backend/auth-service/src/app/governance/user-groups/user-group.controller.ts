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
import { RateLimitBucket, ResellerLimitReached, rateLimitBucketKey, ZodValidationPipe } from '@txnet-backend/shared-core';
import { Request } from 'express';

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
import { UserGroupPersonService } from './user-group-person.service';
import {
  AddUserGroupMembersBody,
  ChangeUserGroupMembersBody,
  CreateUserGroupBody,
  SetUserGroupAccessBody,
  SetUserGroupMemberEndBody,
  UpdateUserGroupBody,
  UserGroupMemberPageQuery,
  addUserGroupMembersSchema,
  changeUserGroupMembersSchema,
  createUserGroupSchema,
  setUserGroupAccessSchema,
  setUserGroupMemberEndSchema,
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
  expiry_past: 400,
  member_conflict: 400,
};

export const USER_GROUP_READ = {
  key: (req: Request & { user?: AuthClaims }) => rateLimitBucketKey(RateLimitBucket.USER_GROUP_READ, req?.user?.sub ?? req?.ip),
  configKey: 'USER_GROUP_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
export const USER_GROUP_WRITE = {
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
  constructor(
    private readonly groups: UserGroupAdminService,
    private readonly person: UserGroupPersonService,
  ) {}

  @Get()
  @RateLimit(USER_GROUP_READ)
  list(@Req() req: Request) {
    return this.refusing(() => this.groups.list(this.actor(req)));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(USER_GROUP_WRITE)
  create(@Body(new ZodValidationPipe(createUserGroupSchema)) body: CreateUserGroupBody, @Req() req: Request) {
    // The schema requires `name`; the cast is for this project's non-strict
    // tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.groups.create(this.actor(req), body as UserGroupInput));
  }

  @Patch(':id')
  @RateLimit(USER_GROUP_WRITE)
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(updateUserGroupSchema)) body: UpdateUserGroupBody, @Req() req: Request) {
    return this.refusing(() => this.groups.update(this.actor(req), id, body));
  }

  @Delete(':id')
  @RateLimit(USER_GROUP_WRITE)
  remove(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.refusing(() => this.groups.remove(this.actor(req), id));
  }

  /** One person's groups, for their page (GR-1-u): in it or not, until when, and whether this caller may change it. */
  @Get('people/:userId')
  @RateLimit(USER_GROUP_READ)
  personGroups(@Param('userId', new ParseUUIDPipe()) userId: string, @Req() req: Request) {
    return this.refusing(() => this.person.of(this.actor(req), userId));
  }

  @Get(':id/members')
  @RateLimit(USER_GROUP_READ)
  members(@Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodValidationPipe(userGroupMemberPageSchema)) query: UserGroupMemberPageQuery, @Req() req: Request) {
    const q = query as Required<UserGroupMemberPageQuery>;
    return this.refusing(() => this.groups.members(this.actor(req), id, q.page, q.pageSize));
  }

  /** What the group gives its user members: a role and/or keys, the whole set (AC-1-m, ADR-0138). */
  @Put(':id/access')
  @RateLimit(USER_GROUP_WRITE)
  setAccess(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(setUserGroupAccessSchema)) body: SetUserGroupAccessBody, @Req() req: Request) {
    return this.refusing(() => this.groups.setAccess(this.actor(req), id, body));
  }

  @Post(':id/members')
  @HttpCode(HttpStatus.OK)
  @RateLimit(USER_GROUP_WRITE)
  addMembers(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(addUserGroupMembersSchema)) body: AddUserGroupMembersBody, @Req() req: Request) {
    return this.refusing(() => this.groups.addMembers(this.actor(req), id, body));
  }

  /** Every member change of one save, all or none (GR-1-i). */
  @Post(':id/members/changes')
  @HttpCode(HttpStatus.OK)
  @RateLimit(USER_GROUP_WRITE)
  changeMembers(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(changeUserGroupMembersSchema)) body: ChangeUserGroupMembersBody, @Req() req: Request) {
    return this.refusing(() => this.groups.changeMembers(this.actor(req), id, body));
  }

  /** A membership's end moved or cleared in place (GR-1-d). */
  @Patch(':id/members/users/:userId')
  @RateLimit(USER_GROUP_WRITE)
  setMemberEnd(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(setUserGroupMemberEndSchema)) body: SetUserGroupMemberEndBody,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.groups.setMemberEnd(this.actor(req), id, userId, body.expiresAt ?? null));
  }

  @Delete(':id/members/users/:userId')
  @RateLimit(USER_GROUP_WRITE)
  removeUser(@Param('id', new ParseUUIDPipe()) id: string, @Param('userId', new ParseUUIDPipe()) userId: string, @Req() req: Request) {
    return this.refusing(() => this.groups.removeMember(this.actor(req), id, { userId }));
  }

  @Delete(':id/members/tenants/:tenantId')
  @RateLimit(USER_GROUP_WRITE)
  removeTenant(@Param('id', new ParseUUIDPipe()) id: string, @Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.groups.removeMember(this.actor(req), id, { tenantId }));
  }

  /** The caller, as `AuthGuard` left them on the request. */
  private actor(req: Request): UserGroupActor {
    const user = (req as Request & { user: AuthClaims }).user;
    // `admin_audit_log.adminIpAddress` is `NOT NULL`; an unresolvable peer is recorded as such.
    return { adminId: user.sub, tenantId: user.tenantId, ip: req.ip ?? '0.0.0.0', permissions: user.permissions };
  }

  private refusing<T>(work: () => Promise<T>): Promise<T> {
    return answeringRefusals(work);
  }
}

/**
 * One refusal type in, one HTTP status out — the reason travels as the body's
 * `reason`. Both paths answer with it: the session's tenant here, a reseller's
 * by path in `ResellerUserGroupsController`.
 */
export async function answeringRefusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    // Past the reseller's staff_members_max (GR-1-b): the figures say what to raise.
    if (err instanceof ResellerLimitReached) throw new ConflictException({ reason: err.reason, message: err.message, facts: err.facts });
    if (!(err instanceof UserGroupRefused)) throw err;
    // `facts.detail` names the member or key refused, so a save of many can point at its row (GR-1-i).
    const body = { reason: err.reason, message: err.message, ...(err.detail ? { facts: { detail: err.detail } } : {}) };
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
