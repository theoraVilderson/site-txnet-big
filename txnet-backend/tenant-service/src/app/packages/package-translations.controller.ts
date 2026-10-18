import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { type ItemTextDraft, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { PlatformPermissionGuard, PlatformRoute } from '../request/platform-permission.guard';
import { PackageTranslationsService } from './package-translations.service';
import { actorOf, refusing } from './tenant-package.controller';
import {
  type EditPackageTextsInput,
  type ListPackageTextsInput,
  type PublishPackageTextsInput,
  editPackageTextsSchema,
  listPackageTextsSchema,
  publishPackageTextsSchema,
} from './tenant-package.schema';

/**
 * Reviewing package name and description drafts (ADR-0154 decision 6), with
 * catalog's routes and shapes under `/api/tenant-packages/translations`:
 * `GET ?lang=`, `POST draft-missing`, `POST publish {lang, keys}`,
 * `PATCH {lang, texts}`. The same caller as the packages themselves.
 */
@Controller('tenant-packages/translations')
@UseGuards(PlatformPermissionGuard)
@PlatformRoute('platform.plan.assign')
export class PackageTranslationsController {
  constructor(private readonly translations: PackageTranslationsService) {}

  @Get()
  async list(@Req() req: Request, @Query(new ZodValidationPipe(listPackageTextsSchema)) query: ListPackageTextsInput, @Ip() ip: string): Promise<ItemTextDraft[]> {
    return refusing(() => this.translations.listTextDrafts(actorOf(req, ip), query.lang));
  }

  @Post('draft-missing')
  @HttpCode(HttpStatus.OK)
  async draftMissing(@Req() req: Request, @Ip() ip: string): Promise<{ drafted: number }> {
    return refusing(() => this.translations.draftMissingTexts(actorOf(req, ip)));
  }

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  async publish(@Req() req: Request, @Body(new ZodValidationPipe(publishPackageTextsSchema)) body: PublishPackageTextsInput, @Ip() ip: string): Promise<{ published: number }> {
    return refusing(() => this.translations.publishTextDrafts(actorOf(req, ip), body));
  }

  @Patch()
  async edit(@Req() req: Request, @Body(new ZodValidationPipe(editPackageTextsSchema)) body: EditPackageTextsInput, @Ip() ip: string): Promise<{ published: number }> {
    return refusing(() => this.translations.editTexts(actorOf(req, ip), body));
  }
}
