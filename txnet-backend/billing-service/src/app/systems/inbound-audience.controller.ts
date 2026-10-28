import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '@txnet-backend/shared-core';
import { GrantBulkPage, grantBulkPageSchema } from '../payment/gift/grant-bulk-job.schema';
import { InboundReleaseInput, InboundReleaseService } from './inbound-release';
import { InboundAudienceInput, MemberInboundsService } from './member-inbounds';
import { ReleaseInboundBody, releaseInboundSchema, SetInboundAudienceBody, setInboundAudienceSchema, SetListingShareBody, setListingShareSchema } from './panel-registration.schema';
import { SYSTEMS_ADMIN_READ, SYSTEMS_ADMIN_SETTINGS, SYSTEMS_ADMIN_WRITE } from './systems-budgets';
import { RESELLER_SYSTEMS_PATH, SystemsDoorGuard, systemsActorOf } from './systems-door';
import { refusing } from './systems-refusals';

/**
 * Who sells one inbound, how much of it each group may take, and releasing it
 * from groups with live configs there (F-027-ep, F-027-eq, F-027-es; ADR-0127
 * decisions 1, 3 and 6). Beside `SystemsController` rather than in it, which
 * is past its size.
 */
@Controller(['billing/systems', RESELLER_SYSTEMS_PATH])
@UseGuards(SystemsDoorGuard)
export class InboundAudienceController {
  constructor(
    private readonly memberInbounds: MemberInboundsService,
    private readonly releases: InboundReleaseService,
  ) {}

  /** Every group of the panel, or the groups listed. `409 inbound_has_configs` names a group that would lose it with live configs there. */
  @Put('panels/:id/inbounds/:remoteId/audience')
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  set(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('remoteId') remoteId: string,
    @Body(new ZodValidationPipe(setInboundAudienceSchema)) body: SetInboundAudienceBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.memberInbounds.setAudience(systemsActorOf(req), id, remoteId, body as InboundAudienceInput));
  }

  /** A group's share of an inbound it lists; `404 listing_not_found` on any other. */
  @Put('panel-groups/:id/members/:panelId/inbounds/:remoteId/share')
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  share(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Param('remoteId') remoteId: string,
    @Body(new ZodValidationPipe(setListingShareSchema)) body: SetListingShareBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.memberInbounds.setShare(systemsActorOf(req), id, panelId, remoteId, body.maxClients));
  }

  /** The way out of `inbound_has_configs`: **202** a release job, `move` or `empty`; the listing changes when it ends. */
  @Post('panels/:id/inbounds/:remoteId/release')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  release(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('remoteId') remoteId: string,
    @Body(new ZodValidationPipe(releaseInboundSchema)) body: ReleaseInboundBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.releases.start({ ...systemsActorOf(req), ip }, id, remoteId, body as InboundReleaseInput));
  }

  @Get('inbound-releases/:jobId')
  @RateLimit(SYSTEMS_ADMIN_READ)
  releaseJob(@Param('jobId', new ParseUUIDPipe()) jobId: string, @Req() req: Request) {
    return refusing(() => this.releases.job(systemsActorOf(req), jobId));
  }

  @Get('inbound-releases/:jobId/outcomes')
  @RateLimit(SYSTEMS_ADMIN_READ)
  releaseOutcomes(@Param('jobId', new ParseUUIDPipe()) jobId: string, @Query(new ZodValidationPipe(grantBulkPageSchema)) page: GrantBulkPage, @Req() req: Request) {
    return refusing(() => this.releases.outcomes(systemsActorOf(req), jobId, page));
  }

  /** Stops it: what moved stays moved, the listing is as it was. */
  @Post('inbound-releases/:jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  cancelRelease(@Param('jobId', new ParseUUIDPipe()) jobId: string, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.releases.cancel({ ...systemsActorOf(req), ip }, jobId));
  }
}
