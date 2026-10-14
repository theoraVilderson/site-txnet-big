import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { EngagementPermissionGuard } from './engagement-permission.guard';
import { LotteryAdminReportService } from './lottery-admin-report.service';
import { LotteryCancelBody, LotteryDraftBody, lotteryCancelSchema, lotteryDraftSchema } from './lottery-admin.schema';
import { LotteryActor, LotteryAdminRefused, LotteryAdminRejection, LotteryAdminService, LotteryDraftInput } from './lottery-admin.service';
import { ENGAGEMENT_ADMIN_READ, ENGAGEMENT_ADMIN_WRITE } from './wheel-admin.controller';
import { refusalException } from '../request/refusal-exception';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const LOTTERY_ADMIN_REFUSAL_STATUS: Record<LotteryAdminRejection, 400 | 403 | 404 | 409> = {
  invalid_prize: 400,
  invalid_close_time: 400,
  cancel_reason_required: 400,
  coupon_template_not_found: 404,
  variant_not_found: 404,
  group_not_found: 404,
  audience_not_allowed: 403,
  lottery_not_found: 404,
  not_a_draft: 409,
  not_cancellable: 409,
  not_drawn: 409,
};

/**
 * A tenant's lotteries (F-707-i, ADR-0111 points 5, 6):
 * `/api/billing/engagement/lotteries`. Behind `engagement.manage`, confined to
 * the caller's own tenant by RLS (`LotteryAdminService`). A draft is edited
 * and deleted; a published one only cancelled, with a public reason. No route
 * closes, freezes, seeds or draws a lottery: that is the close job's alone
 * (F-707-k, F-707-l). Two reads beside the settings (F-707-o): who would
 * enter if it closed now, and once drawn, who holds each place.
 */
@Controller('billing/engagement/lotteries')
@UseGuards(EngagementPermissionGuard)
export class LotteryAdminController {
  constructor(
    private readonly lotteries: LotteryAdminService,
    private readonly reports: LotteryAdminReportService,
  ) {}

  private actor(req: Request, ip: string): LotteryActor {
    const { userId, tenantId, permissions } = identityOf(req);
    return { adminId: userId, tenantId, ip, permissions };
  }

  @Get()
  @RateLimit(ENGAGEMENT_ADMIN_READ)
  async list(@Req() req: Request, @Ip() ip: string) {
    return this.lotteries.list(this.actor(req, ip));
  }

  @Get(':id')
  @RateLimit(ENGAGEMENT_ADMIN_READ)
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.lotteries.get(this.actor(req, ip), id));
  }

  @Get(':id/eligibility')
  @RateLimit(ENGAGEMENT_ADMIN_READ)
  async eligibility(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.reports.eligibility(this.actor(req, ip), id));
  }

  @Get(':id/winners')
  @RateLimit(ENGAGEMENT_ADMIN_READ)
  async winners(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.reports.winners(this.actor(req, ip), id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(ENGAGEMENT_ADMIN_WRITE)
  async create(@Body(new ZodValidationPipe(lotteryDraftSchema)) body: LotteryDraftBody, @Req() req: Request, @Ip() ip: string) {
    // The cast is for this project's non-strict tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.lotteries.create(this.actor(req, ip), body as LotteryDraftInput));
  }

  @Put(':id')
  @RateLimit(ENGAGEMENT_ADMIN_WRITE)
  async replace(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(lotteryDraftSchema)) body: LotteryDraftBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.lotteries.replace(this.actor(req, ip), id, body as LotteryDraftInput));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(ENGAGEMENT_ADMIN_WRITE)
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    await this.refusing(() => this.lotteries.remove(this.actor(req, ip), id));
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit(ENGAGEMENT_ADMIN_WRITE)
  async publish(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.lotteries.publish(this.actor(req, ip), id));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit(ENGAGEMENT_ADMIN_WRITE)
  async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(lotteryCancelSchema)) body: LotteryCancelBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.lotteries.cancel(this.actor(req, ip), id, body.reason as string));
  }

  /** One place that turns a refusal into a status; the reason travels in the body for the panel to translate. */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof LotteryAdminRefused)) throw e;
      throw refusalException(LOTTERY_ADMIN_REFUSAL_STATUS[e.reason], { reason: e.reason, message: e.message });
    }
  }
}
