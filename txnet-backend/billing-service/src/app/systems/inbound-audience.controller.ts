import { Body, Controller, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { InboundAudienceInput, MemberInboundsService } from './member-inbounds';
import { SetInboundAudienceBody, setInboundAudienceSchema } from './panel-registration.schema';
import { PanelPermissionGuard, SYSTEMS_ADMIN_WRITE, actorOf } from './systems.controller';
import { refusing } from './systems-refusals';

/**
 * Who sells one inbound (F-027-ep, ADR-0127 decision 1):
 * `PUT /api/billing/systems/panels/:id/inbounds/:remoteId/audience` — every
 * group of the panel, or the groups listed. Beside `SystemsController` rather
 * than in it, which is past its size. `409 inbound_has_configs` names a group
 * that would lose it with live configs there.
 */
@Controller('billing/systems/panels/:id/inbounds/:remoteId/audience')
@UseGuards(PanelPermissionGuard)
export class InboundAudienceController {
  constructor(private readonly memberInbounds: MemberInboundsService) {}

  @Put()
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  set(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('remoteId') remoteId: string,
    @Body(new ZodValidationPipe(setInboundAudienceSchema)) body: SetInboundAudienceBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.memberInbounds.setAudience(actorOf(req), id, remoteId, body as InboundAudienceInput));
  }
}
