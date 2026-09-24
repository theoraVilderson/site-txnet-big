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
import { PanelRegistrationService, RegisterPanelInput } from './panel-registration';
import {
  AcknowledgeDriftBody,
  acknowledgeDriftSchema,
  DriftEventQueryInput,
  driftEventQuerySchema,
  RegisterPanelBody,
  registerPanelSchema,
} from './panel-registration.schema';
import { PanelScopeRefused, SystemsActor } from './panel-scope';
import { SystemsReadService, SystemsRefused } from './systems-read';

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
      if (e.reason === 'already_acknowledged') throw new ConflictException({ reason: e.reason, message: e.message });
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
 * Who the caller is comes from the gate (`X-User-Id`, `X-Tenant-Id`), never
 * from the body.
 */
@Controller('billing/systems')
@UseGuards(PanelPermissionGuard)
export class SystemsController {
  constructor(
    private readonly registration: PanelRegistrationService,
    private readonly reads: SystemsReadService,
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

  @Post('panels')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  async register(@Body(new ZodValidationPipe(registerPanelSchema)) body: RegisterPanelBody, @Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    try {
      // The schema requires every field; the cast is for this project's
      // non-strict tsconfig, under which zod infers every key as optional.
      return await this.registration.register({ adminId: userId, tenantId }, body as RegisterPanelInput);
    } catch (e) {
      if (e instanceof PanelScopeRefused) throw new ForbiddenException({ reason: e.reason, message: e.message });
      if (e instanceof PanelCredentialRefused) throw new HttpException({ reason: e.reason, message: e.message }, e.status);
      if (e instanceof PanelCredentialUnavailable) {
        throw new BadGatewayException({ reason: 'credentials_unavailable', message: 'the credential vault could not be reached' });
      }
      throw e;
    }
  }
}

function actorOf(req: Request): SystemsActor {
  const { userId, tenantId } = identityOf(req);
  return { adminId: userId, tenantId };
}
