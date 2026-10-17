import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { GrantBulkPage, grantBulkPageSchema } from '../payment/gift/grant-bulk-job.schema';
import { GrantGroupMoveJobBody, grantGroupMoveJobSchema, GrantGroupMoveSelection, grantGroupMoveSelectionSchema, GrantRegroupBody, grantRegroupSchema } from '../payment/gift/grant-group-move.schema';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { GrantGroupMoveService } from './grant-group-move';
import { PanelPermissionGuard, SYSTEMS_ADMIN_READ, SYSTEMS_ADMIN_WRITE, actorOf } from './systems.controller';
import { refusing } from './systems-refusals';

/**
 * The platform owner moves Grants to another panel group (F-027-et, ADR-0127
 * decision 5): one now, or many as a job — the Grants ticked, or every Grant
 * of one group. Any group, any tenant's Grants (`GrantGroupMoveService`).
 * Refusals: 403 the scope; 404 `grant_not_found` / `group_not_found` /
 * `job_not_found`; 409 the Grant's or target's state and `request_reused`;
 * 422 `selection_empty` / `selection_too_large`.
 */
@Controller('billing/systems')
@UseGuards(PanelPermissionGuard)
export class GrantGroupMoveController {
  constructor(private readonly moves: GrantGroupMoveService) {}

  /** `{toGroupId, reason}` -> `{grantId, fromGroupId, toGroupId, kept, moved}`. */
  @Post('grants/:grantId/group')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  regroup(@Param('grantId', new ParseUUIDPipe()) grantId: string, @Body(new ZodValidationPipe(grantRegroupSchema)) body: GrantRegroupBody, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.moves.one({ ...actorOf(req), ip }, grantId, body));
  }

  /** The confirm's figures: `{grants, keep, move}`. */
  @Post('grant-group-moves/count')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_READ)
  count(@Body(new ZodValidationPipe(grantGroupMoveSelectionSchema)) body: GrantGroupMoveSelection, @Req() req: Request) {
    return refusing(() => this.moves.count(actorOf(req), body));
  }

  @Post('grant-group-moves')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  start(@Body(new ZodValidationPipe(grantGroupMoveJobSchema)) body: GrantGroupMoveJobBody, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.moves.start({ ...actorOf(req), ip }, body));
  }

  @Get('grant-group-moves/:jobId')
  @RateLimit(SYSTEMS_ADMIN_READ)
  job(@Param('jobId', new ParseUUIDPipe()) jobId: string, @Req() req: Request) {
    return refusing(() => this.moves.job(actorOf(req), jobId));
  }

  @Get('grant-group-moves/:jobId/outcomes')
  @RateLimit(SYSTEMS_ADMIN_READ)
  outcomes(@Param('jobId', new ParseUUIDPipe()) jobId: string, @Query(new ZodValidationPipe(grantBulkPageSchema)) page: GrantBulkPage, @Req() req: Request) {
    return refusing(() => this.moves.outcomes(actorOf(req), jobId, page));
  }

  /** Stops it: the Grants moved stay moved. */
  @Post('grant-group-moves/:jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  cancel(@Param('jobId', new ParseUUIDPipe()) jobId: string, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.moves.cancel({ ...actorOf(req), ip }, jobId));
  }
}
