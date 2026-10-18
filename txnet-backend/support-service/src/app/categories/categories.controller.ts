import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, requestLanguage, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { SupportManageGuard } from '../availability/support-manage.guard';
import { callerOf, refusing } from '../conversations/conversations.controller';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { CategoryAdminView, CategoryList, SupportCategories } from './categories';
import { CreateCategoryBody, UpdateCategoryBody, createCategorySchema, updateCategorySchema } from './categories.schema';
import { LocaleService } from '../locale/locale.service';

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_READ, identityOf(req).userId),
  configKey: 'SUPPORT_READ_RATE_LIMIT' as const,
  windowSec: 60,
};

const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_SEND, identityOf(req).userId),
  configKey: 'SUPPORT_SEND_RATE_LIMIT' as const,
  windowSec: 60,
};

/** A tenant's own support categories (F-033-e): `support.manage`. The platform's defaults are read-only to it. */
@Controller('support/settings/categories')
@UseGuards(SupportManageGuard)
export class SupportCategoriesController {
  constructor(
    private readonly categories: SupportCategories,
    private readonly locale: LocaleService,
  ) {}

  @Get()
  @RateLimit(READ)
  list(@Req() req: Request): Promise<CategoryList> {
    return this.categories.list(callerOf(req).tenantId, requestLanguage(req, this.locale));
  }

  @Post()
  @RateLimit(WRITE)
  create(@Req() req: Request, @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryBody): Promise<CategoryAdminView> {
    return refusing(() => this.categories.create(callerOf(req).tenantId, body));
  }

  @Patch(':id')
  @RateLimit(WRITE)
  update(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryBody,
  ): Promise<CategoryAdminView> {
    return refusing(() => this.categories.update(callerOf(req).tenantId, id, body));
  }

  /** Only a category no conversation names; otherwise 409 `category_in_use` — retire it with `isActive: false`. */
  @Delete(':id')
  @HttpCode(204)
  @RateLimit(WRITE)
  async remove(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await refusing(() => this.categories.remove(callerOf(req).tenantId, id));
  }
}
