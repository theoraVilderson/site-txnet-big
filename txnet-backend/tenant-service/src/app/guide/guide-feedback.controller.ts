import { Body, Controller, Get, NotFoundException, Param, Put, Req } from '@nestjs/common';
import { requestLanguage } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { GuideRefused } from './guide-admin';
import { guideKeySchema, guideVoteBodySchema } from './guide-public.schema';
import { GuideStats } from './guide-stats';
import { LocaleService } from '../locale/locale.service';

/**
 * A known user's helpful / not-helpful vote (F-414-l, ADR-0119 point 3):
 * `/api/guides/feedback/:key`, behind `forward-auth` like the settings, but no
 * permission — any signed-in user of the tenant, the panel's or the bot's
 * token. The identity says whose vote it is; the guide must be one the user's
 * tenant shows now, else a 404.
 */
@Controller('guides/feedback')
export class GuideFeedbackController {
  constructor(
    private readonly stats: GuideStats,
    private readonly locale: LocaleService,
  ) {}

  @Get(':key')
  mine(@Req() req: Request, @Param('key', new ZodValidationPipe(guideKeySchema)) key: string): Promise<{ helpful: boolean | null }> {
    const { tenantId, userId } = identityOf(req);
    return unknownAs404(() => this.stats.myVote(tenantId, userId, key, requestLanguage(req, this.locale)));
  }

  @Put(':key')
  vote(
    @Req() req: Request,
    @Param('key', new ZodValidationPipe(guideKeySchema)) key: string,
    @Body(new ZodValidationPipe(guideVoteBodySchema)) body: { helpful: boolean },
  ): Promise<{ helpful: boolean }> {
    const { tenantId, userId } = identityOf(req);
    return unknownAs404(() => this.stats.vote(tenantId, userId, key, body.helpful, requestLanguage(req, this.locale)));
  }
}

async function unknownAs404<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof GuideRefused) throw new NotFoundException({ reason: e.reason, message: e.message });
    throw e;
  }
}

