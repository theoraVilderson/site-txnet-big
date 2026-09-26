import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PublicRoute, TenantContext, publicPath } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import {
  BrandingSlot,
  LineNamePreviewInput,
  UpdateBrandingInput,
  brandingSlotSchema,
  lineNamePreviewSchema,
  lineNameTemplateSchema,
  updateBrandingSchema,
} from './tenant-branding.schema';
import {
  BRANDING_MAX_BYTES,
  BrandingActor,
  BrandingRefused,
  BrandingRejection,
  BrandingView,
  LineNamePreview,
  TenantBrandingService,
  UploadedAsset,
} from './tenant-branding.service';

/** The public read (F-018-h): `GET /api/public/tenant/branding`, its tenant from the Host (F-018-ak). */
export const BRANDING_PATH = publicPath('tenant', 'branding');

/** @deprecated since 2026-09-19, remove after the next release: `GET /api/branding`, before ADR-0065. */
export const LEGACY_BRANDING_PATH = 'branding';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<BrandingRejection, 403 | 404 | 409 | 413 | 415> = {
  not_allowed: 403,
  reseller_suspended: 403,
  reseller_not_found: 404,
  reseller_terminated: 409,
  too_large: 413,
  type_not_allowed: 415,
  type_mismatch: 415,
};

/**
 * A reseller's branding (F-018-h): `GET` / `PUT /api/tenants/:id/branding` for
 * the text, `PUT` / `DELETE /api/tenants/:id/branding/assets/:slot` for an
 * image (multipart, field `file`), `PUT .../line-name-template` and its
 * `POST .../preview` for the default name of a served config line (F-307-j).
 *
 * No `TenantPermissionGuard`: the reseller's owner holds no `tenant.manage`,
 * and is let in by `ResellerAccess` (F-061-h), as the platform owner's staff are.
 */
@Controller('tenants/:id/branding')
export class TenantBrandingController {
  constructor(private readonly branding: TenantBrandingService) {}

  @Get()
  read(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<BrandingView> {
    return refusing(() => this.branding.read(actorOf(req), id));
  }

  @Put()
  update(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateBrandingSchema)) body: UpdateBrandingInput,
  ): Promise<BrandingView> {
    return refusing(() => this.branding.update(actorOf(req), id, body));
  }

  @Put('line-name-template')
  setLineNameTemplate(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(lineNameTemplateSchema)) body: { template: string | null },
  ): Promise<BrandingView> {
    return refusing(() => this.branding.setLineNameTemplate(actorOf(req), id, body.template));
  }

  /** Writes nothing: a 200 with the name, or with why the template would be refused. */
  @Post('line-name-template/preview')
  @HttpCode(200)
  previewLineName(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(lineNamePreviewSchema)) body: LineNamePreviewInput,
  ): Promise<LineNamePreview> {
    return refusing(() => this.branding.previewLineName(actorOf(req), id, body));
  }

  // No `dest`, so multer holds the file in memory, capped before the policy
  // sees it: the largest slot's cap is the most one request can make us hold.
  @Put('assets/:slot')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: BRANDING_MAX_BYTES, files: 1, fields: 0 } }))
  upload(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('slot', new ZodValidationPipe(brandingSlotSchema)) slot: BrandingSlot,
    @UploadedFile() file: UploadedAsset | undefined,
  ): Promise<BrandingView> {
    if (!file) throw new BadRequestException({ reason: 'file_missing', message: 'send the image as multipart field "file"' });
    return refusing(() => this.branding.upload(actorOf(req), id, slot, file));
  }

  @Delete('assets/:slot')
  remove(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('slot', new ZodValidationPipe(brandingSlotSchema)) slot: BrandingSlot,
  ): Promise<BrandingView> {
    return refusing(() => this.branding.remove(actorOf(req), id, slot));
  }
}

/**
 * What the panel and the landing site render (F-018-h): the brand of the
 * tenant whose Host asked. Public — a stranger's first page load has no
 * session — on the same doors as the file route, so an unknown or unproven host
 * is the neutral 404, a host never answers with another tenant's brand, and
 * every image URL it hands out is one the file route will serve.
 */
@Controller([BRANDING_PATH, LEGACY_BRANDING_PATH])
export class BrandingPublicController {
  constructor(private readonly branding: TenantBrandingService) {}

  @Get()
  @PublicRoute({ doors: ['panel', 'assets'] })
  read(): Promise<BrandingView> {
    return this.branding.ofTenant(TenantContext.current('branding by host').id);
  }
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof BrandingRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    switch (STATUS[e.reason]) {
      case 403:
        throw new ForbiddenException(payload);
      case 404:
        throw new NotFoundException(payload);
      case 413:
        throw new HttpException(payload, HttpStatus.PAYLOAD_TOO_LARGE);
      case 415:
        throw new HttpException(payload, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
      default:
        throw new HttpException(payload, HttpStatus.CONFLICT);
    }
  }
}

function actorOf(req: Request): BrandingActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
}
