import {
  BadGatewayException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ConflictException,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { holdsPermission, RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { PanelCredentialRefused, PanelCredentialUnavailable } from './panel-credential.client';
import { PanelRegistrationService, PanelResubmitRefused, RegisterPanelInput } from './panel-registration';
import {
  AcknowledgeDriftBody,
  acknowledgeDriftSchema,
  DriftEventQueryInput,
  driftEventQuerySchema,
  HoldQueueQueryInput,
  holdQueueQuerySchema,
  RegisterPanelBody,
  registerPanelSchema,
  ResubmitCredentialsBody,
  resubmitRadiusSecretSchema,
  ResubmitRadiusSecretBody,
  resubmitCredentialsSchema,
  ReleaseHoldBody,
  releaseHoldSchema,
  WriteOffHoldBody,
  writeOffHoldSchema,
} from './panel-registration.schema';
import { PanelScopeRefused, SystemsActor } from './panel-scope';
import { SystemsReadService, SystemsRefused } from './systems-read';
import { UsageHoldsService } from './usage-holds';

/** The permission the systems surface needs (F-027-ar). SuperAdmin holds it as `*`. */
export const PANEL_MANAGE = 'panel.manage';

/**
 * The first door, like `GatewayPermissionGuard`, and like it **not the
 * boundary**: `PanelRegistrationService` admits the platform owner only.
 */
@Injectable()
export class PanelPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, PANEL_MANAGE)) {
      throw new ForbiddenException(`${PANEL_MANAGE} is required`);
    }
    return true;
  }
}

const SYSTEMS_ADMIN_WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SYSTEMS_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'SYSTEMS_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

const SYSTEMS_ADMIN_READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SYSTEMS_ADMIN_READ, identityOf(req).userId),
  configKey: 'SYSTEMS_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};

/** The service's refusals as HTTP: the scope is a 403, a panel or event outside it a 404. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof PanelScopeRefused) throw new ForbiddenException({ reason: e.reason, message: e.message });
    if (e instanceof SystemsRefused) {
      if (e.reason === 'already_acknowledged' || e.reason === 'already_resolved') throw new ConflictException({ reason: e.reason, message: e.message });
      throw new NotFoundException({ reason: e.reason, message: e.message });
    }
    throw e;
  }
}

/**
 * The platform owner's systems surface (F-027-ar, ADR-0080): `/api/billing/systems`.
 *
 * `POST panels` registers a panel as desired state and answers `201` with
 * `reviewState: pending` — the verdict arrives on `network-service`'s next
 * tick, not in this response. The login goes in and never comes out:
 * `credentials` is `{configured, version, rotatedAt}`.
 *
 * The reads (F-027-as) are what `network-service`'s loops last wrote: the
 * panel list with health and budget, one panel's capability matrix, and the
 * drift report. Acknowledging a drift event is the one write among them, and
 * it resumes a halted panel's collection on the next pass.
 *
 * The holds queue (F-027-at) lists what the meter held, and ends a hold one
 * of two ways: a release is queued for the meter (`202`, the hold stays
 * `pending` until it is billed), a write-off is recorded here and never
 * charged (ADR-0080 decision 3).
 *
 * Who the caller is comes from the gate (`X-User-Id`, `X-Tenant-Id`), never
 * from the body.
 */
@Controller('billing/systems')
@UseGuards(PanelPermissionGuard)
export class SystemsController {
  constructor(
    private readonly registration: PanelRegistrationService,
    private readonly reads: SystemsReadService,
    private readonly holdsQueue: UsageHoldsService,
  ) {}

  @Get('panels')
  @RateLimit(SYSTEMS_ADMIN_READ)
  panels(@Req() req: Request) {
    return refusing(() => this.reads.panels(actorOf(req)));
  }

  @Get('panels/:id/capabilities')
  @RateLimit(SYSTEMS_ADMIN_READ)
  capabilities(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.reads.capabilities(actorOf(req), id));
  }

  @Get('drift-events')
  @RateLimit(SYSTEMS_ADMIN_READ)
  driftEvents(@Query(new ZodValidationPipe(driftEventQuerySchema)) query: DriftEventQueryInput, @Req() req: Request) {
    return refusing(() => this.reads.driftEvents(actorOf(req), query));
  }

  @Post('drift-events/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  acknowledge(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(acknowledgeDriftSchema)) body: AcknowledgeDriftBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.reads.acknowledge(actorOf(req), id, body));
  }

  @Get('holds')
  @RateLimit(SYSTEMS_ADMIN_READ)
  holds(@Query(new ZodValidationPipe(holdQueueQuerySchema)) query: HoldQueueQueryInput, @Req() req: Request) {
    return refusing(() => this.holdsQueue.holds(actorOf(req), query));
  }

  @Post('holds/:id/release')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  release(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(releaseHoldSchema)) body: ReleaseHoldBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.holdsQueue.release(actorOf(req), id, body));
  }

  @Post('holds/:id/write-off')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  writeOff(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(writeOffHoldSchema)) body: WriteOffHoldBody,
    @Req() req: Request,
  ) {
    // Required by the schema; the cast is for the non-strict tsconfig, as in `register`.
    return refusing(() => this.holdsQueue.writeOff(actorOf(req), id, body as { note: string }));
  }

  @Post('panels')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  async register(@Body(new ZodValidationPipe(registerPanelSchema)) body: RegisterPanelBody, @Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    // The schema requires every field; the cast is for this project's
    // non-strict tsconfig, under which zod infers every key as optional.
    return relayingVault(() => this.registration.register({ adminId: userId, tenantId }, body as RegisterPanelInput));
  }

  /**
   * Re-submit a panel's login (F-027-au). `200 {id, reviewState, retest,
   * credentials}`: `retest` is whether the next tick tests it again — only a
   * `pending` panel not cooling off after `rate_limited`. A refused panel is
   * 409 `panel_refused`.
   */
  @Put('panels/:id/credentials')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  resubmitCredentials(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resubmitCredentialsSchema)) body: ResubmitCredentialsBody,
    @Req() req: Request,
  ) {
    return relayingVault(() =>
      refusing(() => this.registration.resubmitCredentials(actorOf(req), id, body.credentials as string)),
    );
  }

  /**
   * Re-submit a push panel's RADIUS secret (F-027-az). `200 {id, reviewState,
   * radiusSecret}`; nothing is re-tested. A pull panel is 409
   * `panel_not_push`, a refused one 409 `panel_refused`.
   */
  @Put('panels/:id/radius-secret')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  resubmitRadiusSecret(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resubmitRadiusSecretSchema)) body: ResubmitRadiusSecretBody,
    @Req() req: Request,
  ) {
    return relayingVault(() =>
      refusing(() => this.registration.resubmitRadiusSecret(actorOf(req), id, body.radiusSecret as string)),
    );
  }
}

/** The routes that write a login or a secret: the scope as 403, the vault seam's refusals relayed, its silence a 502. */
async function relayingVault<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof PanelScopeRefused) throw new ForbiddenException({ reason: e.reason, message: e.message });
    if (e instanceof PanelResubmitRefused) throw new ConflictException({ reason: e.reason, message: e.message });
    if (e instanceof PanelCredentialRefused) throw new HttpException({ reason: e.reason, message: e.message }, e.status);
    if (e instanceof PanelCredentialUnavailable) {
      throw new BadGatewayException({ reason: 'credentials_unavailable', message: 'the credential vault could not be reached' });
    }
    throw e;
  }
}

function actorOf(req: Request): SystemsActor {
  const { userId, tenantId } = identityOf(req);
  return { adminId: userId, tenantId };
}
