import {
  Body,
  CanActivate,
  ConflictException,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, holdsPermission, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import {
  ManualAuthorityBody,
  ManualConfirmBody,
  ManualRejectBody,
  manualAuthoritySchema,
  manualConfirmSchema,
  manualRejectSchema,
} from './manual-confirm.schema';
import { ManualActor, ManualConfirmRefused, ManualConfirmService } from './manual-confirm.service';

/** The permission (F-092-z, ADR-0044 decision 6). SuperAdmin holds it as `*`; `Admin` by migration. */
export const PAYMENT_CONFIRM_MANUAL = 'payment.confirm_manual';

/** The first door — not the boundary, which is `ManualConfirmService`'s scope rule. */
@Injectable()
export class ManualConfirmPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, PAYMENT_CONFIRM_MANUAL)) {
      throw new ForbiddenException(`${PAYMENT_CONFIRM_MANUAL} is required`);
    }
    return true;
  }
}

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.PAYMENT_MANUAL_READ, identityOf(req).userId),
  configKey: 'PAYMENT_MANUAL_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.PAYMENT_MANUAL_WRITE, identityOf(req).userId),
  configKey: 'PAYMENT_MANUAL_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * Manual payment confirmation (F-092-z): `/api/billing/payments/manual`.
 *
 * One surface for the platform owner and every tenant, told apart by the
 * tenant, never by the path (F-098). `inquire` asks the gateway and lets the
 * ordinary path settle whatever it answers; `confirm` does the same first and
 * credits by hand only when the gateway left the payment unsettled.
 */
@Controller('billing/payments/manual')
@UseGuards(ManualConfirmPermissionGuard)
export class ManualConfirmController {
  constructor(private readonly manual: ManualConfirmService) {}

  private actor(req: Request, ip: string): ManualActor {
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId, ip };
  }

  @Get()
  @RateLimit(READ)
  async list(@Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.manual.list(this.actor(req, ip)));
  }

  @Post(':id/inquire')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async inquire(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.manual.inquire(this.actor(req, ip), id));
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async confirm(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualConfirmSchema)) body: ManualConfirmBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The schema requires both keys; the cast is for the non-strict tsconfig.
    return this.refusing(() => this.manual.confirm(this.actor(req, ip), id, body as Required<ManualConfirmBody>));
  }

  /**
   * Attach an authority whose write was lost, read off the gateway's own panel,
   * and ask the gateway about it (F-092-af). 409 when the payment already has
   * one (`authority_present`) or another payment holds it (`authority_taken`).
   */
  @Post(':id/authority')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async attachAuthority(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualAuthoritySchema)) body: ManualAuthorityBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The schema requires the key; the cast is for the non-strict tsconfig.
    return this.refusing(() => this.manual.attachAuthority(this.actor(req, ip), id, body.authority as string));
  }

  /**
   * End an open payment nobody paid (F-092-ak). Billing asks the gateway first;
   * `still_in_bank` and every answer that sees money write nothing.
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualRejectSchema)) body: ManualRejectBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The schema requires the key; the cast is for the non-strict tsconfig.
    return this.refusing(() => this.manual.reject(this.actor(req, ip), id, { reason: body.reason as string }));
  }

  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof ManualConfirmRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      if (e.reason === 'payment_not_found') throw new NotFoundException(payload);
      throw new ConflictException(payload);
    }
  }
}
