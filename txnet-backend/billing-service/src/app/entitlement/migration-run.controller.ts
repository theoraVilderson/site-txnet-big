import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { bulkWriteLimit, ResellerJobRoutes } from '../payment/gift/reseller-job-routes';
import { actorOf, resellerRefusal } from '../payment/gift/reseller-user-grants.controller';
import { ResellerUserGrantsRefused } from '../payment/gift/reseller-user-grants.service';
import { RateLimit } from '../request/rate-limit';
import { MigrationDrainService, type MigrationDrainResult } from './migration-drain';
import { MigrationRunRefused, MigrationRunService, type MigrationRunRejection } from './migration-run';
import { migrationInboundsSchema, migrationRunCreateSchema, type MigrationInbounds, type MigrationRunCreate } from './migration-run.schema';

const STATUS: Record<MigrationRunRejection, 404 | 409 | 422> = {
  run_not_found: 404,
  inbound_not_found: 404,
  variant_not_found: 404,
  run_busy: 409,
  run_closed: 409,
  run_not_previewed: 409,
  run_not_committed: 409,
  rollback_window_closed: 409,
  variant_not_prepaid: 422,
  variant_not_deliverable: 422,
  variant_not_assignable: 422,
};

/** A run's refusal, or the reseller door's, as HTTP; anything else unchanged. */
function migrationRefusal(e: unknown): unknown {
  if (e instanceof ResellerUserGrantsRefused) return resellerRefusal(e);
  if (!(e instanceof MigrationRunRefused)) return e;
  const Exception: new (p: object) => HttpException = { 404: NotFoundException, 409: ConflictException, 422: UnprocessableEntityException }[STATUS[e.reason]];
  return new Exception({ reason: e.reason, message: e.message });
}

/**
 * A reseller's import from another panel (F-206, D-63; entitlement
 * `contract.import.md`). The source login is stored on tenant-service
 * between the create and the preview (tenant `contract.source-login.md`).
 *
 * - `POST …/migration-runs` `{family, sourceAddress}` -> **201** the run, `draft`
 * - `PUT …/migration-runs/:runId/inbounds` `{inbounds: [{inboundRemoteId, variantId}]}` -> the run
 * - `POST …/migration-runs/:runId/preview` -> **202** the run, `previewing`
 * - `POST …/migration-runs/:runId/commit` -> **202** the run, `committing` (F-207)
 * - `POST …/migration-runs/:runId/rollback` -> **202** the run, `rolling_back` (F-211, inside its 7 days)
 * - `GET …/migration-runs`, `GET …/:runId`, `GET …/:runId/outcomes` (the report's table), `POST …/:runId/cancel`
 *
 * All `migration.manage`: `staffWrite` to change, `read` to look. The page
 * hears every move of the run (`entitlement.migration_run.progress`, C-14).
 */
@Controller('billing/tenants/:tenantId/migration-runs')
export class ResellerMigrationRunController extends ResellerJobRoutes {
  constructor(protected readonly jobs: MigrationRunService) {
    super();
  }

  protected refusal(e: unknown): unknown {
    return migrationRefusal(e);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(bulkWriteLimit)
  create(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(migrationRunCreateSchema)) body: MigrationRunCreate, @Req() req: Request) {
    return this.answer(() => this.jobs.create(actorOf(req), tenantId, body));
  }

  @Put(':runId/inbounds')
  @RateLimit(bulkWriteLimit)
  setInbounds(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Body(new ZodValidationPipe(migrationInboundsSchema)) body: MigrationInbounds,
    @Req() req: Request,
  ) {
    return this.answer(() => this.jobs.setInbounds(actorOf(req), tenantId, runId, body));
  }

  @Post(':runId/preview')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(bulkWriteLimit)
  preview(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('runId', new ParseUUIDPipe()) runId: string, @Req() req: Request) {
    return this.answer(() => this.jobs.preview(actorOf(req), tenantId, runId));
  }

  @Post(':runId/commit')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(bulkWriteLimit)
  commit(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('runId', new ParseUUIDPipe()) runId: string, @Req() req: Request) {
    return this.answer(() => this.jobs.commit(actorOf(req), tenantId, runId));
  }

  @Post(':runId/rollback')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(bulkWriteLimit)
  rollback(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('runId', new ParseUUIDPipe()) runId: string, @Req() req: Request) {
    return this.answer(() => this.jobs.rollback(actorOf(req), tenantId, runId));
  }
}

/**
 * The seam `worker-service`'s `migration_run_drain` tick reaches the dry run,
 * the commit and the rollback through (F-206, F-207, F-211), as every drain: service callers only, outside the gate and
 * the tenant (ADR-0027).
 */
@TenantCapability('system')
@Controller('internal/billing/migration-runs')
@UseGuards(ServiceOnlyGuard)
export class MigrationRunInternalController {
  constructor(private readonly drainer: MigrationDrainService) {}

  @Post('drain')
  @HttpCode(200)
  drain(): Promise<MigrationDrainResult> {
    return this.drainer.drain();
  }
}
