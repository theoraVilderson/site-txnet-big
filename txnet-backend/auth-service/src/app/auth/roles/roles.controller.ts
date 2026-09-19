import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';
import { AuthGuard } from '../auth.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { createRoleSchema, updateRoleSchema, type CreateRoleInput, type UpdateRoleInput } from './role.schema';
import type { AuthClaims } from '../token.service';
import { ROLE_MANAGE, RolesService } from './roles.service';

/**
 * `/api/auth/roles` — a tenant administers its own roles (F-018-n, ADR-0062).
 *
 * Under `/auth` because `identity` owns `role` (F-098). `role.manage` is the
 * door; the tenant on the caller's claims is the boundary, and the service
 * applies it to every row it reads or writes.
 */
@Controller('auth/roles')
@UseGuards(AuthGuard, new PermissionsGuard([ROLE_MANAGE]))
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  list(@Req() req: Request) {
    return this.roles.list(claimsOf(req));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ROLE_WRITE, req?.user?.tenantId ?? req?.ip),
    configKey: 'ROLE_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  create(@Req() req: Request, @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleInput) {
    return this.roles.create(claimsOf(req), body);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ROLE_WRITE, req?.user?.tenantId ?? req?.ip),
    configKey: 'ROLE_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  update(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleInput,
  ) {
    return this.roles.update(claimsOf(req), id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ROLE_WRITE, req?.user?.tenantId ?? req?.ip),
    configKey: 'ROLE_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.roles.remove(claimsOf(req), id);
  }
}

function claimsOf(req: Request): AuthClaims {
  return (req as Request & { user: AuthClaims }).user;
}
