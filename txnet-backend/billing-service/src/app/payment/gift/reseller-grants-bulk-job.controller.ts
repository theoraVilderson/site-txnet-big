import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GrantBulkDrainResult, GrantBulkJobDrainService, GrantBulkJobRefused, GrantBulkJobRejection, ResellerGrantBulkJobService } from './grant-bulk-job';
import { GrantBulkJobBody, grantBulkJobSchema, grantBulkCountSchema, GrantBulkPage, grantBulkPageSchema } from './grant-bulk-job.schema';
import { actorOf, resellerRefusal } from './reseller-user-grants.controller';
import { ResellerUserGrantsRefused } from './reseller-user-grants.service';

const STATUS: Record<GrantBulkJobRejection, 404 | 409 | 422> = {
  request_reused: 409,
  selection_empty: 422,
  selection_too_large: 422,
  job_not_found: 404,
};

function refusal(e: unknown): unknown {
  if (e instanceof ResellerUserGrantsRefused) return resellerRefusal(e);
  if (!(e instanceof GrantBulkJobRefused)) return e;
  const payload = { reason: e.reason, message: e.message };
  const Exception: new (p: object) => HttpException = { 404: NotFoundException, 409: ConflictException, 422: UnprocessableEntityException }[STATUS[e.reason]];
  return new Exception(payload);
}

async function answer<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw refusal(e);
  }
}

const writeLimit = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_CONFIG_ACTION, identityOf(req).userId),
  configKey: 'RESELLER_USER_CONFIG_ACTION_RATE_LIMIT' as const,
  windowSec: 900,
};

/** The reseller reads' own bucket, as every reseller read of a user's services spends it. */
const readLimit = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_GRANTS_READ, identityOf(req).userId),
  configKey: 'RESELLER_USER_GRANTS_READ_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * An admin acts on Grants chosen by a filter, as a background job (F-311-u2,
 * spec F-311) — a panel, a product or variant, statuses — instead of 1..50
 * ids (`reseller-grants-bulk.controller.ts`). The confirm counts, then starts;
 * the worker acts in batches; the admin watches the counts and the outcomes.
 *
 * - `POST …/bulk-jobs/count` `{filter}` -> `{count}` (`read`)
 * - `POST …/bulk-jobs` a bulk body with `filter` for `grantIds` -> **202** the
 *   job; the same `requestId` again answers it (`staffWrite`)
 * - `GET …/bulk-jobs`, `GET …/bulk-jobs/:jobId`, `GET …/bulk-jobs/:jobId/outcomes` (`read`)
 * - `POST …/bulk-jobs/:jobId/cancel` (`staffWrite`)
 *
 * Refusals: the door's as every reseller route's (`resellerRefusal`); 409
 * `request_reused`, 422 `selection_empty` / `selection_too_large`, 404
 * `job_not_found`. The writes spend the bulk by id's bucket, per request; the
 * reads the reseller reads' bucket.
 */
@Controller('billing/tenants/:tenantId/grants/bulk-jobs')
export class ResellerGrantsBulkJobController {
  constructor(private readonly service: ResellerGrantBulkJobService) {}

  @Post('count')
  @HttpCode(HttpStatus.OK)
  @RateLimit(readLimit)
  count(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(grantBulkCountSchema)) body: { filter: GrantBulkJobBody['filter'] }, @Req() req: Request) {
    return answer(async () => ({ count: await this.service.count(actorOf(req), tenantId, body.filter) }));
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(writeLimit)
  start(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(grantBulkJobSchema)) body: GrantBulkJobBody, @Req() req: Request, @Ip() ip: string) {
    return answer(() => this.service.start({ ...actorOf(req), ip }, tenantId, body));
  }

  @Get()
  @RateLimit(readLimit)
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(grantBulkPageSchema)) page: GrantBulkPage, @Req() req: Request) {
    return answer(() => this.service.list(actorOf(req), tenantId, page));
  }

  @Get(':jobId')
  @RateLimit(readLimit)
  job(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('jobId', new ParseUUIDPipe()) jobId: string, @Req() req: Request) {
    return answer(() => this.service.job(actorOf(req), tenantId, jobId));
  }

  @Get(':jobId/outcomes')
  @RateLimit(readLimit)
  outcomes(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Query(new ZodValidationPipe(grantBulkPageSchema)) page: GrantBulkPage,
    @Req() req: Request,
  ) {
    return answer(() => this.service.outcomes(actorOf(req), tenantId, jobId, page));
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit(writeLimit)
  cancel(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('jobId', new ParseUUIDPipe()) jobId: string, @Req() req: Request, @Ip() ip: string) {
    return answer(() => this.service.cancel({ ...actorOf(req), ip }, tenantId, jobId));
  }
}

/**
 * The seam `worker-service`'s `grant_bulk_job_drain` tick reaches the drain
 * through (F-311-u2) — outside the gate and the tenant, service callers only,
 * as `EntitlementInternalController` explains. Answers the raw counts: the
 * only caller records them in `bot_execution_log`. After the batch, the
 * retention purge (F-311-u3): `purged` ended jobs, `outcomesPurged` by-id rows.
 */
@TenantCapability('system')
@Controller('internal/billing/grant-bulk-jobs')
@UseGuards(ServiceOnlyGuard)
export class GrantBulkJobInternalController {
  constructor(private readonly drainer: GrantBulkJobDrainService) {}

  @Post('drain')
  @HttpCode(200)
  async drain(): Promise<GrantBulkDrainResult & { purged: number; outcomesPurged: number }> {
    const drained = await this.drainer.drain();
    const { jobs: purged, outcomes: outcomesPurged } = await this.drainer.purge();
    return { ...drained, purged, outcomesPurged };
  }
}
