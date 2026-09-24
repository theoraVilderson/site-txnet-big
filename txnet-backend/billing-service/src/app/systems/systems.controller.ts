import {
  BadGatewayException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { holdsPermission, RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { PanelCredentialRefused, PanelCredentialUnavailable } from './panel-credential.client';
import { PanelRegistrationRefused, PanelRegistrationService, RegisterPanelInput } from './panel-registration';
import { RegisterPanelBody, registerPanelSchema } from './panel-registration.schema';

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

/**
 * The platform owner's systems surface (F-027-ar, ADR-0080): `/api/billing/systems`.
 *
 * `POST panels` registers a panel as desired state and answers `201` with
 * `reviewState: pending` — the verdict arrives on `network-service`'s next
 * tick, not in this response. The login goes in and never comes out:
 * `credentials` is `{configured, version, rotatedAt}`.
 *
 * Who the caller is comes from the gate (`X-User-Id`, `X-Tenant-Id`), never
 * from the body.
 */
@Controller('billing/systems')
@UseGuards(PanelPermissionGuard)
export class SystemsController {
  constructor(private readonly registration: PanelRegistrationService) {}

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
      if (e instanceof PanelRegistrationRefused) throw new ForbiddenException({ reason: e.reason, message: e.message });
      if (e instanceof PanelCredentialRefused) throw new HttpException({ reason: e.reason, message: e.message }, e.status);
      if (e instanceof PanelCredentialUnavailable) {
        throw new BadGatewayException({ reason: 'credentials_unavailable', message: 'the credential vault could not be reached' });
      }
      throw e;
    }
  }
}
