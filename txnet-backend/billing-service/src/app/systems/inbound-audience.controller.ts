import { Body, Controller, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { InboundAudienceInput, MemberInboundsService } from './member-inbounds';
import { SetInboundAudienceBody, setInboundAudienceSchema, SetListingShareBody, setListingShareSchema } from './panel-registration.schema';
import { PanelPermissionGuard, SYSTEMS_ADMIN_WRITE, actorOf } from './systems.controller';
import { refusing } from './systems-refusals';

/**
 * Who sells one inbound, and how much of it each group may take (F-027-ep,
 * F-027-eq, ADR-0127 decisions 1 and 3). Beside `SystemsController` rather
 * than in it, which is past its size.
 */
@Controller('billing/systems')
@UseGuards(PanelPermissionGuard)
export class InboundAudienceController {
  constructor(private readonly memberInbounds: MemberInboundsService) {}

  /** Every group of the panel, or the groups listed. `409 inbound_has_configs` names a group that would lose it with live configs there. */
  @Put('panels/:id/inbounds/:remoteId/audience')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  set(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('remoteId') remoteId: string,
    @Body(new ZodValidationPipe(setInboundAudienceSchema)) body: SetInboundAudienceBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.memberInbounds.setAudience(actorOf(req), id, remoteId, body as InboundAudienceInput));
  }

  /** A group's share of an inbound it lists; `404 listing_not_found` on any other. */
  @Put('panel-groups/:id/members/:panelId/inbounds/:remoteId/share')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  share(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Param('remoteId') remoteId: string,
    @Body(new ZodValidationPipe(setListingShareSchema)) body: SetListingShareBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.memberInbounds.setShare(actorOf(req), id, panelId, remoteId, body.maxClients));
  }
}
