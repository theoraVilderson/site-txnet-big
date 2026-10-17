import { Body, ConflictException, Controller, Get, HttpCode, HttpStatus, Ip, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GRANT_REGROUP_STATUS, GrantRegroupRefused } from '../../traffic/grant-regroup';
import { GrantGroupMoveJobBody, grantGroupMoveJobSchema, GrantGroupMoveSelection, grantGroupMoveSelectionSchema, GrantRegroupBody, grantRegroupSchema } from './grant-group-move.schema';
import { moveJobRefusal } from './reseller-config-move-job.controller';
import { ResellerGrantGroupMoveService } from './reseller-grant-group-move';
import { bulkReadLimit, bulkWriteLimit, ResellerJobRoutes } from './reseller-job-routes';
import { actionLimit, actorOf, adminOf, grantActRefusal } from './reseller-user-grants.controller';

/** A group move's refusal, the job's, the reseller's limit or its door, as HTTP. */
function refusal(e: unknown): unknown {
  if (e instanceof GrantRegroupRefused) {
    const Exception = GRANT_REGROUP_STATUS[e.reason] === 404 ? NotFoundException : ConflictException;
    return new Exception({ reason: e.reason, message: e.message });
  }
  return moveJobRefusal(grantActRefusal(e));
}

/**
 * A reseller's admin moves many of its users' Grants to another panel group,
 * as a background job (F-027-et, ADR-0127 decision 5) — the Grants ticked,
 * or every Grant of one group, into a group its tenant sells. The confirm
 * counts (Grants, configs kept, configs moved), then starts; the page hears
 * each batch (`network.config_move_job.progress`) and re-reads the job.
 *
 * - `GET …/grant-group-moves/groups` -> `{groups: [{id, name}]}`, the targets it may name (`read`, F-027-ev)
 * - `POST …/grant-group-moves/count` `{source, toGroupId}` -> `{grants, keep, move}` (`read`)
 * - `POST …/grant-group-moves` `{requestId, source, toGroupId, reason}` -> **202** the job (`staffWrite`)
 * - the list, one job, its outcomes and cancel: `ResellerJobRoutes`'
 */
@Controller('billing/tenants/:tenantId/grant-group-moves')
export class ResellerGrantGroupMoveController extends ResellerJobRoutes {
  constructor(protected readonly jobs: ResellerGrantGroupMoveService) {
    super();
  }

  protected refusal(e: unknown): unknown {
    return refusal(e);
  }

  /** `{groups: [{id, name}]}` — the groups its tenant sells, the only targets it may name. Literal, so declared before `:jobId`. */
  @Get('groups')
  @RateLimit(bulkReadLimit)
  groups(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.answer(() => this.jobs.targets(actorOf(req), tenantId));
  }

  @Post('count')
  @HttpCode(HttpStatus.OK)
  @RateLimit(bulkReadLimit)
  count(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(grantGroupMoveSelectionSchema)) body: GrantGroupMoveSelection, @Req() req: Request) {
    return this.answer(() => this.jobs.count(actorOf(req), tenantId, body));
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(bulkWriteLimit)
  start(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(grantGroupMoveJobSchema)) body: GrantGroupMoveJobBody, @Req() req: Request, @Ip() ip: string) {
    return this.answer(() => this.jobs.start(adminOf(req, ip), tenantId, body));
  }
}

/**
 * One of a reseller's users' Grants to another group, now (F-027-et):
 * `{toGroupId, reason}` -> `{grantId, fromGroupId, toGroupId, kept, moved}`.
 * The config actions' bucket, as every admin act on one Grant.
 */
@Controller('billing/tenants/:tenantId/users/:userId/grants')
export class ResellerGrantRegroupController {
  constructor(private readonly moves: ResellerGrantGroupMoveService) {}

  @Post(':grantId/group')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async regroup(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantRegroupSchema)) body: GrantRegroupBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    try {
      return await this.moves.one(adminOf(req, ip), tenantId, userId, grantId, body);
    } catch (e) {
      throw refusal(e);
    }
  }
}
