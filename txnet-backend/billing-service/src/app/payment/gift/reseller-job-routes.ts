import { Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, ResellerActor, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { GrantBulkPage, grantBulkPageSchema } from './grant-bulk-job.schema';
import { actorOf } from './reseller-user-grants.controller';
import { AdminActor } from './reseller-user-grants.service';

/** A job's writes spend the bulk by id's bucket, per request: one job is one admin decision. */
export const bulkWriteLimit = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_CONFIG_ACTION, identityOf(req).userId),
  configKey: 'RESELLER_USER_CONFIG_ACTION_RATE_LIMIT' as const,
  windowSec: 900,
};

/** A job's reads spend the reseller reads' own bucket, as every reseller read of a user's services does. */
export const bulkReadLimit = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_GRANTS_READ, identityOf(req).userId),
  configKey: 'RESELLER_USER_GRANTS_READ_RATE_LIMIT' as const,
  windowSec: 900,
};

/** What a reseller job's service answers the routes every job has. */
export interface ResellerJobs {
  list(actor: ResellerActor, tenantId: string, page: GrantBulkPage): Promise<unknown>;
  job(actor: ResellerActor, tenantId: string, jobId: string): Promise<unknown>;
  outcomes(actor: ResellerActor, tenantId: string, jobId: string, page: GrantBulkPage): Promise<unknown>;
  cancel(actor: AdminActor, tenantId: string, jobId: string): Promise<unknown>;
}

/**
 * The four routes every reseller job has — the list, one job, its outcomes,
 * its cancel — declared once for a bulk job by filter (F-311-u2) and a config
 * move job (F-311-ad). A subclass is the `@Controller`, names its service and
 * maps its refusals; its own routes are declared before these, so a literal
 * path (`panels`) is matched before `:jobId`.
 */
export abstract class ResellerJobRoutes {
  protected abstract readonly jobs: ResellerJobs;

  /** The job's refusals as HTTP; anything else is rethrown as it is. */
  protected abstract refusal(e: unknown): unknown;

  protected async answer<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      throw this.refusal(e);
    }
  }

  @Get()
  @RateLimit(bulkReadLimit)
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(grantBulkPageSchema)) page: GrantBulkPage, @Req() req: Request) {
    return this.answer(() => this.jobs.list(actorOf(req), tenantId, page));
  }

  @Get(':jobId')
  @RateLimit(bulkReadLimit)
  job(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('jobId', new ParseUUIDPipe()) jobId: string, @Req() req: Request) {
    return this.answer(() => this.jobs.job(actorOf(req), tenantId, jobId));
  }

  @Get(':jobId/outcomes')
  @RateLimit(bulkReadLimit)
  outcomes(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Query(new ZodValidationPipe(grantBulkPageSchema)) page: GrantBulkPage,
    @Req() req: Request,
  ) {
    return this.answer(() => this.jobs.outcomes(actorOf(req), tenantId, jobId, page));
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit(bulkWriteLimit)
  cancel(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('jobId', new ParseUUIDPipe()) jobId: string, @Req() req: Request, @Ip() ip: string) {
    return this.answer(() => this.jobs.cancel({ ...actorOf(req), ip }, tenantId, jobId));
  }
}
