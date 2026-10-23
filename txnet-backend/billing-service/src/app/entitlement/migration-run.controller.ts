import {
  Body,
  ConflictException,
  Controller,
  Get,
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

import { bulkReadLimit, bulkWriteLimit, ResellerJobRoutes } from '../payment/gift/reseller-job-routes';
import { actorOf, resellerRefusal } from '../payment/gift/reseller-user-grants.controller';
import { ResellerUserGrantsRefused } from '../payment/gift/reseller-user-grants.service';
import { RateLimit } from '../request/rate-limit';
import { resubmitCredentialsSchema, type ResubmitCredentialsBody } from '../systems/panel-registration.schema';
import { refusing, relayingVault } from '../systems/systems-refusals';
import { BalanceImportService } from '../wallet/balance-import-run';
import { LegacyHostService } from './legacy-host';
import { MigrationLinkService } from './migration-link-run';
import { MigrationRouterService } from './migration-router';
import { MigrationDrainService, type MigrationDrainResult } from './migration-drain';
import { MigrationRunRefused, MigrationRunService, type MigrationRunRejection } from './migration-run';
import {
  isCsvRunCreate,
  isLinkRunCreate,
  legacyHostTestSchema,
  migrationAnyRunCreateSchema,
  migrationInboundsSchema,
  migrationLinkCorrectionSchema,
  migrationRouterSchema,
  type LegacyHostTest,
  type MigrationAnyRunCreate,
  type MigrationInbounds,
  type MigrationLinkCorrection,
  type MigrationRouterBody,
} from './migration-run.schema';

const STATUS: Record<MigrationRunRejection, 404 | 409 | 422> = {
  run_not_found: 404,
  legacy_link_not_found: 404,
  user_not_found: 404,
  variant_unchosen: 409,
  legacy_host_not_routed: 409,
  inbound_not_found: 404,
  variant_not_found: 404,
  panel_not_found: 404,
  panel_required: 422,
  family_not_in_place: 422,
  run_busy: 409,
  run_closed: 409,
  run_not_previewed: 409,
  run_not_committed: 409,
  rollback_window_closed: 409,
  variant_not_prepaid: 422,
  variant_not_deliverable: 422,
  variant_not_assignable: 422,
  csv_columns: 422,
  csv_empty: 422,
  csv_too_many_rows: 422,
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
 * - `POST …/migration-runs` `{family, sourceAddress}` -> **201** the run, `draft`;
 *   or `{url, userId}` -> **201** one person's link run, `previewing` (F-201-g);
 *   or `{csv}` -> **201** a balance file's run, `previewed` with its report (F-209-a)
 * - `PUT …/migration-runs/:runId/link` `{variantId?, dataLimitBytes?, usedBytes?, expiresAt?}` -> the link run, re-planned
 * - `PUT …/migration-runs/:runId/inbounds` `{inbounds: [{inboundRemoteId, variantId}]}` -> the run
 * - `POST …/migration-runs/:runId/preview` -> **202** the run, `previewing`
 * - `POST …/migration-runs/:runId/commit` -> **202** the run, `committing` (F-207)
 * - `POST …/migration-runs/:runId/rollback` -> **202** the run, `rolling_back` (F-211, inside its 7 days)
 * - `GET …/migration-runs`, `GET …/:runId`, `GET …/:runId/outcomes` (the report's table), `POST …/:runId/cancel`
 * - `GET …/migration-runs/legacy-hosts`, `POST …/legacy-hosts/test` `{host}` — the old hosts to point here and a test of one (F-204-b)
 * - `GET …/migration-runs/routers`, `POST …/routers` `{family, name, apiBaseUrl, credentials}` -> **201** `pending`,
 *   `PUT …/routers/:panelId/credentials` `{credentials}` — the reseller's own routers for an import in place (F-1601-g, ADR-0162)
 *
 * All `migration.manage`: `staffWrite` to change, `read` to look. The page
 * hears every move of the run (`entitlement.migration_run.progress`, C-14).
 */
@Controller('billing/tenants/:tenantId/migration-runs')
export class ResellerMigrationRunController extends ResellerJobRoutes {
  constructor(
    protected readonly jobs: MigrationRunService,
    private readonly legacy: LegacyHostService,
    private readonly links: MigrationLinkService,
    private readonly balances: BalanceImportService,
    private readonly routers: MigrationRouterService,
  ) {
    super();
  }

  protected refusal(e: unknown): unknown {
    return migrationRefusal(e);
  }

  // Declared before the base class's `:jobId`, so the literal path is matched first.
  @Get('legacy-hosts')
  @RateLimit(bulkReadLimit)
  legacyHosts(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.answer(() => this.legacy.hosts(actorOf(req), tenantId));
  }

  /** An outside fetch per call: it spends the write bucket, as an action does. */
  @Post('legacy-hosts/test')
  @HttpCode(HttpStatus.OK)
  @RateLimit(bulkWriteLimit)
  testLegacyHost(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(legacyHostTestSchema)) body: LegacyHostTest, @Req() req: Request) {
    return this.answer(() => this.legacy.test(actorOf(req), tenantId, body.host));
  }

  @Get('routers')
  @RateLimit(bulkReadLimit)
  routerList(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.answer(() => this.routers.list(actorOf(req), tenantId));
  }

  /** The panel's own refusals (an address registered already, the vault's) are the systems routes' (`refusing`, `relayingVault`). */
  @Post('routers')
  @RateLimit(bulkWriteLimit)
  // The cast is for the non-strict tsconfig, as in the systems `register`.
  registerRouter(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(migrationRouterSchema)) body: MigrationRouterBody, @Req() req: Request) {
    return this.answer(() => relayingVault(() => refusing(() => this.routers.register(actorOf(req), tenantId, body as Required<MigrationRouterBody>))));
  }

  @Put('routers/:panelId/credentials')
  @RateLimit(bulkWriteLimit)
  resubmitRouterLogin(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Body(new ZodValidationPipe(resubmitCredentialsSchema)) body: ResubmitCredentialsBody,
    @Req() req: Request,
  ) {
    return this.answer(() => relayingVault(() => refusing(() => this.routers.resubmit(actorOf(req), tenantId, panelId, body.credentials))));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(bulkWriteLimit)
  create(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(migrationAnyRunCreateSchema)) body: MigrationAnyRunCreate, @Req() req: Request) {
    const actor = actorOf(req);
    if (isCsvRunCreate(body)) return this.answer(() => this.balances.create(actor, tenantId, body.csv));
    return this.answer(() => (isLinkRunCreate(body) ? this.links.create(actor, tenantId, body) : this.jobs.create(actor, tenantId, body)));
  }

  @Put(':runId/link')
  @RateLimit(bulkWriteLimit)
  correctLink(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Body(new ZodValidationPipe(migrationLinkCorrectionSchema)) body: MigrationLinkCorrection,
    @Req() req: Request,
  ) {
    return this.answer(() => this.links.correct(actorOf(req), tenantId, runId, body));
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
