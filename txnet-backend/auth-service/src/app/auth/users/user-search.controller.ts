import { Controller, Get, HttpCode, HttpStatus, Query, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';
import { AuthGuard } from '../auth.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { userSearchSchema, type UserSearchInput } from '../auth.schema';
import type { AuthClaims } from '../token.service';
import { USER_SEARCH, UserSearchService } from './user-search.service';

/**
 * `GET /api/auth/users?q=` — the platform owner finds a user (F-018-ad).
 *
 * Under `/auth` because `identity` owns `user` (F-098). `user.search` is the
 * first door; the service's platform-owner check is the boundary.
 */
@Controller('auth/users')
export class UserSearchController {
  constructor(private readonly users: UserSearchService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard, new PermissionsGuard([USER_SEARCH]))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.USER_SEARCH, req?.user?.sub ?? req?.ip),
    configKey: 'USER_SEARCH_RATE_LIMIT',
    windowSec: 900,
  })
  search(@Req() req: Request, @Query(new ZodValidationPipe(userSearchSchema)) query: UserSearchInput) {
    return this.users.search((req as Request & { user: AuthClaims }).user, query);
  }
}
