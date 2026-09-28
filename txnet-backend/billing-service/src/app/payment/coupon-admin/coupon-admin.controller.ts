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
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import {
  CreateCouponBody,
  GenerateBatchBody,
  ListBatchesQuery,
  ListCouponsQuery,
  UpdateCouponBody,
  UsageQuery,
  createCouponSchema,
  generateBatchSchema,
  listBatchesSchema,
  listCouponsSchema,
  updateCouponSchema,
  usageSchema,
} from './coupon-admin.schema';
import { CouponActor, CouponAdminRefused, CouponAdminRejection, CouponAdminService, CreateCouponInput, UpdateCouponInput } from './coupon-admin.service';
import { CouponBatchService, GenerateBatchInput } from './coupon-batch.service';
import { CouponPermissionGuard } from './coupon-permission.guard';
import { CouponUsageService } from './coupon-usage.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const COUPON_REFUSAL_STATUS: Record<CouponAdminRejection, 400 | 403 | 404 | 409> = {
  not_platform_owner: 403,
  coupon_not_found: 404,
  batch_not_found: 404,
  tenant_not_found: 404,
  gateway_not_found: 404,
  scope_not_found: 404,
  variant_not_found: 404,
  code_taken: 409,
  used_coupon_frozen: 409,
  capacity_below_used: 409,
  invalid_code: 400,
  invalid_value: 400,
  invalid_limit: 400,
  invalid_batch: 400,
  limits_not_for_gift_codes: 400,
  targeted_needs_users: 400,
  user_out_of_scope: 400,
  platform_coupon_needs_platform_gateway: 400,
};

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.COUPON_ADMIN_READ, identityOf(req).userId),
  configKey: 'COUPON_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.COUPON_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'COUPON_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * Coupon and gift-code management (F-502-f, D-33): `/api/billing/coupons`.
 *
 * One surface for two audiences, told apart by the tenant, never by the path:
 * the platform owner manages platform coupons and every tenant's, any other
 * tenant its own. `CouponPermissionGuard` is the first door and the services
 * the real one (ADR-0048 decision 8).
 *
 * **Route order matters.** `batches/...` is declared before `:id` so the
 * literal segment is never read as a coupon id.
 *
 * **Exporting a batch is a write.** The CSV is the credit itself, so it spends
 * the write budget and leaves an audit row (F-502-d).
 */
@Controller('billing/coupons')
@UseGuards(CouponPermissionGuard)
export class CouponAdminController {
  constructor(
    private readonly coupons: CouponAdminService,
    private readonly batches: CouponBatchService,
    private readonly usage: CouponUsageService,
  ) {}

  private actor(req: Request, ip: string): CouponActor {
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId, ip };
  }

  @Get()
  @RateLimit(READ)
  async list(@Query(new ZodValidationPipe(listCouponsSchema)) query: ListCouponsQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.coupons.list(this.actor(req, ip), query));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async create(@Body(new ZodValidationPipe(createCouponSchema)) body: CreateCouponBody, @Req() req: Request, @Ip() ip: string) {
    // The schema requires code, type and value; the cast is for this project's
    // non-strict tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.coupons.create(this.actor(req, ip), body as CreateCouponInput));
  }

  @Get('batches')
  @RateLimit(READ)
  async listBatches(@Query(new ZodValidationPipe(listBatchesSchema)) query: ListBatchesQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.batches.list(this.actor(req, ip), query));
  }

  @Post('batches')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async generate(@Body(new ZodValidationPipe(generateBatchSchema)) body: GenerateBatchBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.batches.generate(this.actor(req, ip), body as GenerateBatchInput));
  }

  @Get('batches/:id')
  @RateLimit(READ)
  async batch(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.batches.get(this.actor(req, ip), id));
  }

  /**
   * The batch's codes as CSV, inside the ordinary JSON envelope: the panel reads
   * every billing answer through one client, and builds the file in the browser.
   */
  @Get('batches/:id/export')
  @RateLimit(WRITE)
  async exportBatch(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    const csv = await this.refusing(() => this.batches.exportCsv(this.actor(req, ip), id));
    return { filename: `gift-codes-${id}.csv`, csv };
  }

  @Post('batches/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async deactivateBatch(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.batches.deactivate(this.actor(req, ip), id));
  }

  @Get('batches/:id/usage')
  @RateLimit(READ)
  async batchUsage(@Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodValidationPipe(usageSchema)) query: UsageQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.usage.forBatch(this.actor(req, ip), id, query));
  }

  @Get(':id')
  @RateLimit(READ)
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.coupons.get(this.actor(req, ip), id));
  }

  @Patch(':id')
  @RateLimit(WRITE)
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(updateCouponSchema)) body: UpdateCouponBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.coupons.update(this.actor(req, ip), id, body as UpdateCouponInput));
  }

  /** The answer's `mode` says whether the row is gone or, because something redeemed it, soft-deleted. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.coupons.remove(this.actor(req, ip), id));
  }

  @Get(':id/usage')
  @RateLimit(READ)
  async couponUsage(@Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodValidationPipe(usageSchema)) query: UsageQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.usage.forCoupon(this.actor(req, ip), id, query));
  }

  /** One place that turns a refusal into a status; the reason travels in the body for the panel to translate. */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof CouponAdminRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (COUPON_REFUSAL_STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        case 409:
          throw new ConflictException(payload);
        default:
          throw new BadRequestException(payload);
      }
    }
  }
}
