import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { GuideKind } from '@prisma/client';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import {
  GUIDE_IMAGE_POLICY,
  GuideActor,
  GuideAdmin,
  GuideDetail,
  GuideList,
  GuidePreview,
  GuideRefused,
  GuideRejection,
  UploadedGuideFile,
} from './guide-admin';
import {
  CreateGuideBody,
  DraftBody,
  PlacementsBody,
  createGuideSchema,
  draftSchema,
  placementsSchema,
  previewQuerySchema,
  updateGuideSchema,
} from './guide-admin.schema';
import { GuideManageGuard } from './guide-manage.guard';
import { guideKeySchema } from './guide-public.schema';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<GuideRejection, 400 | 404 | 409 | 413 | 415> = {
  guide_unknown: 404,
  guide_not_inherited: 404,
  guide_key_taken: 409,
  guide_no_draft: 409,
  guide_invalid: 400,
  guide_slot: 400,
  guide_product_unknown: 400,
  guide_file: 400,
  too_large: 413,
  type_not_allowed: 415,
  type_mismatch: 415,
};

/**
 * The guide settings (F-414-c, ADR-0117): `guide.manage`. The platform owner's
 * admin edits the platform's guides; a reseller's admin its own, and overrides
 * or hides the platform's by key. Texts are drafts until published; preview
 * renders the draft. Images are multipart field `file`, PNG/WebP/JPEG ≤ 2 MiB.
 */
@Controller('guides/settings')
@UseGuards(GuideManageGuard)
export class GuideAdminController {
  constructor(private readonly guides: GuideAdmin) {}

  @Get()
  list(@Req() req: Request): Promise<GuideList> {
    return this.guides.list(actorOf(req), languageOf(req));
  }

  @Post()
  create(@Req() req: Request, @Body(new ZodValidationPipe(createGuideSchema)) body: CreateGuideBody): Promise<GuideDetail> {
    return refusing(() => this.guides.create(actorOf(req), body));
  }

  /** Inherited by key: an own draft copy of a platform guide. */
  @Post('inherited/:key/override')
  override(@Req() req: Request, @Param('key', new ZodValidationPipe(guideKeySchema)) key: string): Promise<GuideDetail> {
    return refusing(() => this.guides.override(actorOf(req), key));
  }

  @Put('inherited/:key/hidden')
  @HttpCode(204)
  async hide(@Req() req: Request, @Param('key', new ZodValidationPipe(guideKeySchema)) key: string): Promise<void> {
    await refusing(() => this.guides.setHidden(actorOf(req), key, true));
  }

  @Delete('inherited/:key/hidden')
  @HttpCode(204)
  async unhide(@Req() req: Request, @Param('key', new ZodValidationPipe(guideKeySchema)) key: string): Promise<void> {
    await refusing(() => this.guides.setHidden(actorOf(req), key, false));
  }

  @Get(':id')
  get(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<GuideDetail> {
    return refusing(() => this.guides.get(actorOf(req), id));
  }

  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateGuideSchema)) body: { kind?: GuideKind; sortOrder?: number },
  ): Promise<GuideDetail> {
    return refusing(() => this.guides.update(actorOf(req), id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await refusing(() => this.guides.remove(actorOf(req), id));
  }

  @Put(':id/draft')
  saveDraft(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(draftSchema)) body: DraftBody,
  ): Promise<GuideDetail> {
    return refusing(() => this.guides.saveDraft(actorOf(req), id, body.texts));
  }

  @Delete(':id/draft')
  discardDraft(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<GuideDetail> {
    return refusing(() => this.guides.discardDraft(actorOf(req), id));
  }

  /** Writes nothing: the draft (else the published text) as a reader would get it. */
  @Get(':id/preview')
  preview(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(previewQuerySchema)) q: { lang?: string },
  ): Promise<GuidePreview> {
    return refusing(() => this.guides.preview(actorOf(req), id, q.lang ?? languageOf(req)));
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<GuideDetail> {
    return refusing(() => this.guides.publish(actorOf(req), id));
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<GuideDetail> {
    return refusing(() => this.guides.archive(actorOf(req), id, true));
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<GuideDetail> {
    return refusing(() => this.guides.archive(actorOf(req), id, false));
  }

  @Put(':id/placements')
  setPlacements(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(placementsSchema)) body: PlacementsBody,
  ): Promise<GuideDetail> {
    return refusing(() => this.guides.setPlacements(actorOf(req), id, body.placements));
  }

  // In memory, capped before the policy sees it — as branding's upload.
  @Post(':id/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: GUIDE_IMAGE_POLICY.maxBytes, files: 1, fields: 0 } }))
  upload(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: UploadedGuideFile | undefined,
  ): Promise<{ key: string }> {
    if (!file) throw new BadRequestException({ reason: 'file_missing', message: 'send the image as multipart field "file"' });
    return refusing(() => this.guides.upload(actorOf(req), id, file));
  }
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof GuideRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    switch (STATUS[e.reason]) {
      case 400:
        throw new BadRequestException(payload);
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

function actorOf(req: Request): GuideActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
}

function languageOf(req: Request): string {
  return (req as Request & { language?: string }).language ?? 'fa';
}
