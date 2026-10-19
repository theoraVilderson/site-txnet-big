import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { holdsPermission, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import {
  ManualAuthorityBody,
  ManualConfirmBody,
  ManualRejectBody,
  manualAuthoritySchema,
  manualConfirmSchema,
  manualRejectSchema,
} from './manual-confirm.schema';
import { MANUAL_READ, MANUAL_WRITE, manualRefusing } from './manual-confirm.http';
import { ManualActor, ManualConfirmService } from './manual-confirm.service';


/** The permission (F-092-z, ADR-0044 decision 6). SuperAdmin holds it as `*`; a staff group gives it. */
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
  @RateLimit(MANUAL_READ)
  async list(@Req() req: Request, @Ip() ip: string) {
    return manualRefusing(() => this.manual.list(this.actor(req, ip)));
  }

  @Post(':id/inquire')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MANUAL_WRITE)
  async inquire(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return manualRefusing(() => this.manual.inquire(this.actor(req, ip), id));
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MANUAL_WRITE)
  async confirm(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualConfirmSchema)) body: ManualConfirmBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The schema requires the reason; the cast is for the non-strict tsconfig.
    return manualRefusing(() => this.manual.confirm(this.actor(req, ip), id, { referenceId: body.referenceId, reason: body.reason as string }));
  }

  /**
   * A transfer's receipt bytes (F-805-b), for a surface with no Host to spend
   * the signed `receiptUrl` on — the bot. Outside the envelope: the body is the
   * image; a refusal is the ordinary envelope.
   */
  @Get(':id/receipt')
  @RateLimit(MANUAL_READ)
  async receipt(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string, @Res() res: Response): Promise<void> {
    const file = await manualRefusing(() => this.manual.receipt(this.actor(req, ip), id));
    res.set({ 'Content-Type': file.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.status(200).send(file.bytes);
  }

  /**
   * Attach an authority whose write was lost, read off the gateway's own panel,
   * and ask the gateway about it (F-092-af). 409 when the payment already has
   * one (`authority_present`) or another payment holds it (`authority_taken`).
   */
  @Post(':id/authority')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MANUAL_WRITE)
  async attachAuthority(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualAuthoritySchema)) body: ManualAuthorityBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The schema requires the key; the cast is for the non-strict tsconfig.
    return manualRefusing(() => this.manual.attachAuthority(this.actor(req, ip), id, body.authority as string));
  }

  /**
   * End an open payment nobody paid (F-092-ak). Billing asks the gateway first;
   * `still_in_bank` and every answer that sees money write nothing.
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MANUAL_WRITE)
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualRejectSchema)) body: ManualRejectBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The schema requires the key; the cast is for the non-strict tsconfig.
    return manualRefusing(() => this.manual.reject(this.actor(req, ip), id, { reason: body.reason as string, resubmit: body.resubmit === true }));
  }
}
