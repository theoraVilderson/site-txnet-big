import {
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
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  TenantCapabilityName,
  accessTraceOf,
  holdsPermission,
} from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../../auth/auth.guard';
import { RateLimit } from '../../auth/decorators/rate-limit.decorator';
import { TENANT_CEILING } from '../../auth/roles/tenant-roles.service';
import type { AuthClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { USER_GROUP_READ, USER_GROUP_WRITE, answeringRefusals } from './user-group.controller';
import { UserGroupActor, UserGroupAdminService, UserGroupInput, UserGroupView } from './user-group-admin.service';
import {
  AddUserGroupMembersBody,
  CreateUserGroupBody,
  SetUserGroupAccessBody,
  SetUserGroupMemberEndBody,
  UpdateUserGroupBody,
  UserGroupMemberPageQuery,
  addUserGroupMembersSchema,
  createUserGroupSchema,
  setUserGroupAccessSchema,
  setUserGroupMemberEndSchema,
  updateUserGroupSchema,
  userGroupMemberPageSchema,
} from './user-group.schema';

/** Invariant 21's refusals; a new reason does not compile until it gets a status. */
const STATUS: Record<ResellerAccessRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
};

/**
 * `/api/auth/tenants/:tenantId/user-groups/...` — a reseller's groups, by the
 * path (ADR-0064 (1), ADR-0139 (5)): the list (F-102-g-d) and, since GR-1-d,
 * every write the ambient `/auth/user-groups` has — create, rename, delete,
 * members with their end, and access. The owner is a user of the platform's
 * tenant and has no session on the reseller, so the ambient routes would act
 * on the platform's groups; this is how a reseller page reaches its own.
 *
 * {@link ResellerAccess} (invariant 21) admits the owner, the reseller's own
 * member holding `user_group.manage`, or the platform's staff, and the ambient
 * service runs in the reseller's scope — RLS, not a filter here, keeps it to
 * that reseller's groups, and the service's rules apply unchanged. What the
 * caller may *give* is the tenant ceiling (as a role, `TenantRolesService`):
 * whole for the owner, the part they hold for anyone else — so the platform's
 * staff give only keys they hold, and `*` is never one.
 */
@Controller('auth/tenants/:tenantId/user-groups')
@UseGuards(AuthGuard)
export class ResellerUserGroupsController {
  constructor(
    private readonly access: ResellerAccess,
    private readonly groups: UserGroupAdminService,
  ) {}

  @Get()
  @RateLimit(USER_GROUP_READ)
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request): Promise<UserGroupView[]> {
    return this.run(req, tenantId, 'read', (actor) => this.groups.list(actor));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(USER_GROUP_WRITE)
  create(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(createUserGroupSchema)) body: CreateUserGroupBody, @Req() req: Request) {
    return this.run(req, tenantId, 'staffWrite', (actor) => this.groups.create(actor, body as UserGroupInput));
  }

  @Patch(':id')
  @RateLimit(USER_GROUP_WRITE)
  update(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateUserGroupSchema)) body: UpdateUserGroupBody,
    @Req() req: Request,
  ) {
    return this.run(req, tenantId, 'staffWrite', (actor) => this.groups.update(actor, id, body));
  }

  @Delete(':id')
  @RateLimit(USER_GROUP_WRITE)
  remove(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.run(req, tenantId, 'staffWrite', (actor) => this.groups.remove(actor, id));
  }

  @Get(':id/members')
  @RateLimit(USER_GROUP_READ)
  members(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(userGroupMemberPageSchema)) query: UserGroupMemberPageQuery,
    @Req() req: Request,
  ) {
    const q = query as Required<UserGroupMemberPageQuery>;
    return this.run(req, tenantId, 'read', (actor) => this.groups.members(actor, id, q.page, q.pageSize));
  }

  @Put(':id/access')
  @RateLimit(USER_GROUP_WRITE)
  setAccess(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setUserGroupAccessSchema)) body: SetUserGroupAccessBody,
    @Req() req: Request,
  ) {
    return this.run(req, tenantId, 'staffWrite', (actor) => this.groups.setAccess(actor, id, body));
  }

  @Post(':id/members')
  @HttpCode(HttpStatus.OK)
  @RateLimit(USER_GROUP_WRITE)
  addMembers(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addUserGroupMembersSchema)) body: AddUserGroupMembersBody,
    @Req() req: Request,
  ) {
    return this.run(req, tenantId, 'staffWrite', (actor) => this.groups.addMembers(actor, id, body));
  }

  @Patch(':id/members/users/:userId')
  @RateLimit(USER_GROUP_WRITE)
  setMemberEnd(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(setUserGroupMemberEndSchema)) body: SetUserGroupMemberEndBody,
    @Req() req: Request,
  ) {
    return this.run(req, tenantId, 'staffWrite', (actor) => this.groups.setMemberEnd(actor, id, userId, body.expiresAt ?? null));
  }

  @Delete(':id/members/users/:userId')
  @RateLimit(USER_GROUP_WRITE)
  removeUser(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ) {
    return this.run(req, tenantId, 'staffWrite', (actor) => this.groups.removeMember(actor, id, { userId }));
  }

  /**
   * Admit, then run `work` in the reseller's scope as the actor the service
   * weighs. The door's refusals and the service's are answered here, each with
   * its own status.
   */
  private async run<T>(req: Request, tenantId: string, capability: TenantCapabilityName, work: (actor: UserGroupActor) => Promise<T>): Promise<T> {
    const user = (req as Request & { user: AuthClaims }).user;
    const caller = { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions, trace: accessTraceOf(req) };
    try {
      return await answeringRefusals(() =>
        this.access.for('user_group.manage').run(caller, tenantId, capability, (admitted) => work(this.actorOf(user, req, admitted))),
      );
    } catch (err) {
      if (!(err instanceof ResellerAccessRefused)) throw err;
      const body = { reason: err.reason, message: err.message };
      if (STATUS[err.reason] === 404) throw new NotFoundException(body);
      if (STATUS[err.reason] === 409) throw new ConflictException(body);
      throw new ForbiddenException(body);
    }
  }

  /**
   * The actor in the reseller: its own member keeps their own keys; the owner
   * gives the whole tenant ceiling, the platform's staff the part of it they hold.
   */
  private actorOf(user: AuthClaims, req: Request, admitted: AdmittedReseller): UserGroupActor {
    const permissions =
      admitted.as === 'member'
        ? user.permissions
        : admitted.as === 'owner'
          ? TENANT_CEILING
          : TENANT_CEILING.filter((key) => holdsPermission(user.permissions, key));
    return { adminId: user.sub, tenantId: admitted.id, ip: req.ip ?? '0.0.0.0', permissions, as: admitted.as };
  }
}
