import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { MANUAL_READ, MANUAL_WRITE, manualRefusing } from './manual-confirm.http';
import {
  ManualAuthorityBody,
  ManualConfirmBody,
  ManualRejectBody,
  manualAuthoritySchema,
  manualConfirmSchema,
  manualRejectSchema,
} from './manual-confirm.schema';
import { ResellerManualActor, ResellerManualConfirmService } from './reseller-manual-confirm.service';

/**
 * A named reseller's payments to confirm (F-093-v):
 * `/api/billing/tenants/:tenantId/payments/manual`, shaped exactly like
 * `/api/billing/payments/manual` so the panel's screen serves both.
 *
 * **No `ManualConfirmPermissionGuard`**, as on the reseller's gateway routes
 * (F-066-w3): its owner holds no `payment.confirm_manual`, and `ResellerAccess`
 * is the door instead. The receipt bytes route is the bot's and stays ambient;
 * the panel shows the signed `receiptUrl` the list carries.
 */
@Controller('billing/tenants/:tenantId/payments/manual')
export class ResellerManualConfirmController {
  constructor(private readonly manual: ResellerManualConfirmService) {}

  private actor(req: Request, ip: string): ResellerManualActor {
    const { userId, tenantId, permissions } = identityOf(req);
    return { userId, tenantId, permissions, ip };
  }

  @Get()
  @RateLimit(MANUAL_READ)
  async list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return manualRefusing(() => this.manual.list(this.actor(req, ip), tenantId));
  }

  @Post(':id/inquire')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MANUAL_WRITE)
  async inquire(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return manualRefusing(() => this.manual.inquire(this.actor(req, ip), tenantId, id));
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MANUAL_WRITE)
  async confirm(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualConfirmSchema)) body: ManualConfirmBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The schema requires the reason; the cast is for the non-strict tsconfig.
    return manualRefusing(() => this.manual.confirm(this.actor(req, ip), tenantId, id, { referenceId: body.referenceId, reason: body.reason as string }));
  }

  @Post(':id/authority')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MANUAL_WRITE)
  async attachAuthority(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualAuthoritySchema)) body: ManualAuthorityBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return manualRefusing(() => this.manual.attachAuthority(this.actor(req, ip), tenantId, id, body.authority as string));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MANUAL_WRITE)
  async reject(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(manualRejectSchema)) body: ManualRejectBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return manualRefusing(() =>
      this.manual.reject(this.actor(req, ip), tenantId, id, { reason: body.reason as string, resubmit: body.resubmit === true }),
    );
  }
}
