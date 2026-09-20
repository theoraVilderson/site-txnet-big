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
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { isBotPlatform } from '@txnet-backend/messenger';
import { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { RateLimit } from '../auth/decorators/rate-limit.decorator';
import type { AuthClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ConnectBotBody,
  connectBotSchema,
} from './reseller-bot.schema';
import {
  ConnectBotInput,
  ResellerBotActor,
  ResellerBotRefused,
  ResellerBotRejection,
  ResellerBotService,
} from './reseller-bot.service';

/** Every refusal of either door gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerBotRejection, 400 | 403 | 404 | 409 | 503> = {
  // ResellerAccess (tenant invariant 21): who may configure this reseller.
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  // ResellerBotService: what may be done to its bots.
  invalid_token: 400,
  bot_already_connected: 409,
  primary_exists: 409,
  bot_not_found: 404,
  vault_unavailable: 503,
};

/**
 * A named reseller's bots (F-066-w5, ADR-0064):
 * `/api/auth/tenants/:tenantId/bots` — list, connect, retire. The surface the
 * onboarding console's bot step is finished through (F-066-w6).
 *
 * **No `PermissionsGuard`**, as on the other reseller-named surfaces: a
 * reseller's owner holds no operator permission — they are the platform's
 * customer — so `ResellerAccess` is the door, applied inside the service
 * together with the scope the work then runs in. `AuthGuard` is still here,
 * because that door needs a caller to judge.
 *
 * **The tenant is the path's.** The owner signs in to the platform owner's
 * tenant (ADR-0059), so the session's `X-Tenant-Id` would configure the wrong
 * one; the body has no `tenantId` and `.strict()` refuses one.
 *
 * **What a bot is named by.** A retire takes the `@handle`, never the webhook
 * path: the path is a credential, so it is neither an input here nor an output
 * — no answer on this surface carries it, or the token, or the vault label
 * (F-323, ADR-0009).
 */
@Controller('auth/tenants/:tenantId/bots')
@UseGuards(AuthGuard)
export class ResellerBotController {
  constructor(private readonly bots: ResellerBotService) {}

  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_BOT_READ, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_BOT_READ_RATE_LIMIT',
    windowSec: 900,
  })
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.bots.list(this.actor(req), tenantId));
  }

  /**
   * Connect a bot from a pasted token.
   *
   * 201 even when `registered` is `false`: the bot *was* connected, and a
   * messenger that refused the webhook is something the screen says out loud
   * rather than something the status code hides.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_BOT_WRITE, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_BOT_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  connect(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(connectBotSchema)) body: ConnectBotBody,
    @Req() req: Request,
  ) {
    // The schema requires both keys and `platform` is derived from
    // `BOT_PLATFORMS` (C-09); the cast is for this project's non-strict
    // tsconfig, under which zod infers every key as optional and widens the
    // enum back to `string`.
    return this.refusing(() =>
      this.bots.connect(this.actor(req), tenantId, body as unknown as ConnectBotInput),
    );
  }

  @Delete(':platform/:botUsername')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_BOT_WRITE, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_BOT_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  retire(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('platform') platform: string,
    @Param('botUsername') botUsername: string,
    @Req() req: Request,
  ) {
    // An unknown platform is the same 404 an unknown handle is: neither says
    // whether the other would have matched.
    if (!isBotPlatform(platform)) throw new NotFoundException();
    return this.refusing(() =>
      this.bots.retire(this.actor(req), tenantId, platform, botUsername),
    );
  }

  /** The caller, as `AuthGuard` left them on the request. */
  private actor(req: Request): ResellerBotActor {
    const user = (req as Request & { user: AuthClaims }).user;
    return { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions };
  }

  /** One refusal type in, one HTTP status out — the reason travels as the body's `reason`. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof ResellerBotRefused)) throw err;
      const body = { reason: err.reason };
      switch (STATUS[err.reason]) {
        case 400:
          throw new BadRequestException(body);
        case 403:
          throw new ForbiddenException(body);
        case 404:
          throw new NotFoundException(body);
        case 409:
          throw new ConflictException(body);
        default:
          throw new ServiceUnavailableException(body);
      }
    }
  }
}
