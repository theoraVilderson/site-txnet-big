import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '@txnet-backend/shared-core';
import { PanelCostBody, PanelCostService, panelCostSchema } from './panel-cost';
import { SYSTEMS_ADMIN_READ, SYSTEMS_ADMIN_WRITE } from './systems.controller';
import { RESELLER_SYSTEMS_PATH, SystemsDoorGuard, systemsActorOf } from './systems-door';
import { refusing } from './systems-refusals';

/**
 * A panel's monthly cost (F-1002-a): `/api/billing/systems/panels/:id/cost` on
 * the systems surface — its guard, buckets and refusals — beside
 * `SystemsController` rather than in it, which is past its size.
 * `GET` answers `{current, history}`; `POST` adds a price and answers the same.
 */
@Controller(['billing/systems/panels/:id/cost', `${RESELLER_SYSTEMS_PATH}/panels/:id/cost`])
@UseGuards(SystemsDoorGuard)
export class PanelCostController {
  constructor(private readonly costs: PanelCostService) {}

  @Get()
  @RateLimit(SYSTEMS_ADMIN_READ)
  history(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.costs.history(systemsActorOf(req), id));
  }

  @Post()
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  set(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(panelCostSchema)) body: PanelCostBody, @Req() req: Request) {
    return refusing(() => this.costs.set(systemsActorOf(req), id, body));
  }
}
