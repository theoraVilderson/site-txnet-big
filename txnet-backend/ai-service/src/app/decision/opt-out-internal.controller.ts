import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AiSubjectKind } from '@prisma/client';
import { ok, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { OptOuts } from './opt-out';

const subjectSchema = z.object({
  tenantId: z.string().uuid(),
  subjectKind: z.nativeEnum(AiSubjectKind),
  subjectId: z.string().uuid(),
});

/**
 * The seam the "don't show me this again" tap reaches (F-1505): the bot's
 * button (F-038-g) and the panel card (F-038-h) both call it with the action
 * the message carried and the subject the caller authenticated as — never one
 * the message itself names. Service callers only, as every route here until
 * ai-service gets a Traefik route; anyone else gets a neutral 404.
 */
@TenantCapability('system')
@Controller('api/internal/ai/actions')
@UseGuards(ServiceOnlyGuard)
export class OptOutInternalController {
  constructor(private readonly optOuts: OptOuts) {}

  @Post(':actionId/opt-out')
  @HttpCode(200)
  async optOut(@Param('actionId', new ParseUUIDPipe()) actionId: string, @Body() body: unknown) {
    const parsed = subjectSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    const { tenantId, subjectKind, subjectId } = parsed.data;
    const done = await this.optOuts.optOutFrom({ tenantId, kind: subjectKind, id: subjectId }, actionId, new Date());
    if (!done) throw new NotFoundException();
    return ok(done);
  }
}
