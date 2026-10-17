import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { ConfigMoveDrainResult, ConfigMoveJobDrainService, ConfigMoveJobRefused, ConfigMoveJobRejection, ResellerConfigMoveJobService } from './config-move-job';
import { ConfigMoveJobBody, configMoveJobSchema, ConfigMoveSelection, configMoveSelectionSchema } from './config-move-job.schema';
import { bulkReadLimit, bulkWriteLimit, ResellerJobRoutes } from './reseller-job-routes';
import { actorOf, resellerRefusal } from './reseller-user-grants.controller';
import { ResellerUserGrantsRefused } from './reseller-user-grants.service';

const STATUS: Record<ConfigMoveJobRejection, 404 | 409 | 422> = {
  request_reused: 409,
  selection_empty: 422,
  selection_too_large: 422,
  same_panel: 422,
  job_not_found: 404,
  panel_not_found: 404,
};

function refusal(e: unknown): unknown {
  if (e instanceof ResellerUserGrantsRefused) return resellerRefusal(e);
  if (!(e instanceof ConfigMoveJobRefused)) return e;
  const Exception: new (p: object) => HttpException = { 404: NotFoundException, 409: ConflictException, 422: UnprocessableEntityException }[STATUS[e.reason]];
  return new Exception({ reason: e.reason, message: e.message });
}

/**
 * A reseller's admin moves many configs to one panel, as a background job
 * (F-311-ad, D-63) — every live config on a panel, or of the users named, to
 * a target from `…/users/:userId/configs/move-targets`. The confirm counts,
 * then starts; the worker moves in batches; the page hears each batch
 * (`network.config_move_job.progress`) and re-reads the job.
 *
 * - `POST …/move-jobs/count` `{source, toPanelId}` -> `{count}` (`read`)
 * - `POST …/move-jobs` `{requestId, source, toPanelId, reason}` -> **202** the job (`staffWrite`)
 * - `GET …/move-jobs`, `GET …/move-jobs/:jobId`, `GET …/move-jobs/:jobId/outcomes` (`read`)
 * - `POST …/move-jobs/:jobId/cancel` (`staffWrite`)
 *
 * Refusals: the door's (`resellerRefusal`); 404 `panel_not_found` /
 * `job_not_found`; 409 `request_reused`; 422 `same_panel`, `selection_empty`,
 * `selection_too_large`. The buckets, and the list, job, outcomes and cancel
 * routes, are `ResellerJobRoutes`'.
 */
@Controller('billing/tenants/:tenantId/configs/move-jobs')
export class ResellerConfigMoveJobController extends ResellerJobRoutes {
  constructor(protected readonly jobs: ResellerConfigMoveJobService) {
    super();
  }

  protected refusal(e: unknown): unknown {
    return refusal(e);
  }

  @Post('count')
  @HttpCode(HttpStatus.OK)
  @RateLimit(bulkReadLimit)
  count(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(configMoveSelectionSchema)) body: ConfigMoveSelection, @Req() req: Request) {
    return this.answer(async () => ({ count: await this.jobs.count(actorOf(req), tenantId, body) }));
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(bulkWriteLimit)
  start(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(configMoveJobSchema)) body: ConfigMoveJobBody, @Req() req: Request, @Ip() ip: string) {
    return this.answer(() => this.jobs.start({ ...actorOf(req), ip }, tenantId, body));
  }
}

/**
 * The seam `worker-service`'s `config_move_job_drain` tick reaches the drain
 * through (F-311-ad), as `GrantBulkJobInternalController`: service callers
 * only, outside the gate and the tenant. After the batch, the retention purge.
 */
@TenantCapability('system')
@Controller('internal/billing/config-move-jobs')
@UseGuards(ServiceOnlyGuard)
export class ConfigMoveJobInternalController {
  constructor(private readonly drainer: ConfigMoveJobDrainService) {}

  @Post('drain')
  @HttpCode(200)
  async drain(): Promise<ConfigMoveDrainResult & { purged: number }> {
    const drained = await this.drainer.drain();
    const { jobs: purged } = await this.drainer.purge();
    return { ...drained, purged };
  }
}
