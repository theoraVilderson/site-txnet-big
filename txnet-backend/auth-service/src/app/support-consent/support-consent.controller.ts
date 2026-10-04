import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { RateLimit, RateLimitOptions } from '../auth/decorators/rate-limit.decorator';
import type { AuthClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ConsentPolicyBody,
  GrantConsentBody,
  RequestConsentBody,
  consentPolicySchema,
  grantConsentSchema,
  requestConsentSchema,
} from './support-consent.schema';
import {
  SupportConsentActor,
  SupportConsentRefused,
  SupportConsentRejection,
  SupportConsentService,
} from './support-consent.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<SupportConsentRejection, 400 | 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  platform_cannot_grant: 403,
  only_platform_requests: 403,
  request_pending: 409,
  hours_out_of_range: 400,
  consent_not_found: 404,
};

const read: RateLimitOptions = {
  key: (req) =>
    rateLimitBucketKey(RateLimitBucket.SUPPORT_CONSENT_READ, req?.user?.sub ?? req?.ip ?? ''),
  configKey: 'SUPPORT_CONSENT_READ_RATE_LIMIT',
  windowSec: 900,
};
const write: RateLimitOptions = {
  key: (req) =>
    rateLimitBucketKey(RateLimitBucket.SUPPORT_CONSENT_WRITE, req?.user?.sub ?? req?.ip ?? ''),
  configKey: 'SUPPORT_CONSENT_WRITE_RATE_LIMIT',
  windowSec: 900,
};

/**
 * `/api/auth/tenants/:tenantId/support-consent` (F-117-a, ADR-0104 (4)) — the
 * platform's time-bound access to a reseller's people: the history and the
 * reseller's default, a request (platform staff), a grant, a revoke, the
 * default. No `PermissionsGuard`, as on every reseller-named surface:
 * `ResellerAccess` is the door, applied in the service.
 */
@Controller('auth/tenants/:tenantId/support-consent')
@UseGuards(AuthGuard)
export class SupportConsentController {
  constructor(private readonly consent: SupportConsentService) {}

  @Get()
  @RateLimit(read)
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.consent.list(this.actor(req), tenantId));
  }

  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(write)
  request(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(requestConsentSchema)) body: RequestConsentBody,
    @Req() req: Request,
  ) {
    return this.refusing(() =>
      this.consent.request(this.actor(req), tenantId, body as Required<RequestConsentBody>, req.ip ?? ''),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(write)
  grant(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(grantConsentSchema)) body: GrantConsentBody,
    @Req() req: Request,
  ) {
    return this.refusing(() =>
      this.consent.grant(this.actor(req), tenantId, body as GrantConsentBody & Pick<Required<GrantConsentBody>, 'scope'>, req.ip ?? ''),
    );
  }

  @Post(':consentId/revoke')
  @HttpCode(HttpStatus.OK)
  @RateLimit(write)
  revoke(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('consentId', new ParseUUIDPipe()) consentId: string,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.consent.revoke(this.actor(req), tenantId, consentId, req.ip ?? ''));
  }

  @Put('policy')
  @RateLimit(write)
  setPolicy(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(consentPolicySchema)) body: ConsentPolicyBody,
    @Req() req: Request,
  ) {
    return this.refusing(() =>
      this.consent.setPolicy(this.actor(req), tenantId, body.defaultHours as number, req.ip ?? ''),
    );
  }

  private actor(req: Request): SupportConsentActor {
    const user = (req as Request & { user: AuthClaims }).user;
    return { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions };
  }

  /** One refusal type in, one HTTP status out — the reason travels as the body's `reason`. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof SupportConsentRefused)) throw err;
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
