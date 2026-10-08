import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth.guard';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthClaims } from '../token.service';
import { UserStatusInput, UserStatusRefusal, UserStatusRefused, UserStatusService } from './user-status.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<UserStatusRefusal, 400 | 403 | 404> = {
  wrong_tenant: 403,
  user_not_found: 404,
  no_permission: 403,
  reason_required: 400,
  self: 403,
  owner: 403,
  not_above: 403,
};

/** The reason is shown to the person verbatim, so it is bounded, not rich text. */
export const userStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
  reason: z.string().max(500).optional(),
});

/**
 * `PUT /api/auth/users/:userId/status` `{status, reason}` — staff restrict,
 * ban and lift (BAN-1-d, ADR-0133). Under `/auth` because `identity` owns
 * `user`. Which key it needs depends on the change (`restriction.assign` or
 * `user.ban`), so the service asks, not a `PermissionsGuard`.
 */
@Controller('auth/users')
export class UserStatusController {
  constructor(private readonly users: UserStatusService) {}

  @Get(':userId/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  read(@Req() req: Request, @Param('userId', ParseUUIDPipe) userId: string) {
    const claims = (req as Request & { user: AuthClaims }).user;
    return this.refusing(() =>
      this.users.read({ userId: claims.sub, tenantId: claims.tenantId, permissions: claims.permissions }, userId),
    );
  }

  @Put(':userId/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  // The reseller users-admin's own write budget: the same act, by another door.
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_WRITE, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_USER_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  set(
    @Req() req: Request,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(userStatusSchema)) body: z.infer<typeof userStatusSchema>,
  ) {
    const claims = (req as Request & { user: AuthClaims }).user;
    return this.refusing(() =>
      this.users.set(
        { userId: claims.sub, tenantId: claims.tenantId, permissions: claims.permissions },
        userId,
        // Validated by the pipe; the workspace's non-strict zod types every key optional.
        body as UserStatusInput,
        req.ip ?? '0.0.0.0',
      ),
    );
  }

  /** One refusal type in, one HTTP status out — the reason travels as the body's `reason`. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof UserStatusRefused)) throw err;
      const response = { reason: err.reason };
      if (STATUS[err.reason] === 400) throw new BadRequestException(response);
      if (STATUS[err.reason] === 404) throw new NotFoundException(response);
      throw new ForbiddenException(response);
    }
  }
}
