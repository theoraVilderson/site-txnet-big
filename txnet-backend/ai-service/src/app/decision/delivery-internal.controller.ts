import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ok, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ActionDelivery } from './delivery';

/** Why a claim (F-038-g1) stops a suggestion: the user muted it, or a retention notice came first. */
export const CLAIM_STOPS = ['muted', 'after_retention'] as const;

const takeSchema = z.object({ limit: z.number().int().min(1).max(200) }).strict();
const actionSchema = z.object({ tenantId: z.string().uuid() }).strict();
const stopSchema = z.object({ tenantId: z.string().uuid(), by: z.enum(CLAIM_STOPS), retryAt: z.string().datetime().optional() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.path.join('.')).join(', '));
  return parsed.data;
}

/**
 * The seams worker-service delivers a suggestion through (F-038-g2, its job
 * is F-038-g3): take what is due, run the safety floor, mark it sent or stop
 * it. Service callers only (else a neutral 404); each call names the action's
 * tenant, and an action not `scheduled` in it is 404.
 */
@TenantCapability('system')
@Controller('api/internal/ai/actions')
@UseGuards(ServiceOnlyGuard)
export class DeliveryInternalController {
  constructor(private readonly delivery: ActionDelivery) {}

  @Post('due/take')
  @HttpCode(200)
  async take(@Body() body: unknown) {
    const { limit } = parse(takeSchema, body);
    return ok({ items: await this.delivery.take(limit, new Date()) });
  }

  @Post(':actionId/floor')
  @HttpCode(200)
  async floor(@Param('actionId', new ParseUUIDPipe()) actionId: string, @Body() body: unknown) {
    const { tenantId } = parse(actionSchema, body);
    const verdict = await this.delivery.floor(tenantId, actionId, new Date());
    if (!verdict) throw new NotFoundException();
    return ok(verdict);
  }

  @Post(':actionId/sent')
  @HttpCode(200)
  async sent(@Param('actionId', new ParseUUIDPipe()) actionId: string, @Body() body: unknown) {
    const { tenantId } = parse(actionSchema, body);
    return ok(await this.delivery.sent(tenantId, actionId, new Date()));
  }

  @Post(':actionId/stop')
  @HttpCode(200)
  async stop(@Param('actionId', new ParseUUIDPipe()) actionId: string, @Body() body: unknown) {
    const { tenantId, by, retryAt } = parse(stopSchema, body);
    const done = await this.delivery.stop(tenantId, actionId, by, retryAt ? new Date(retryAt) : null, new Date());
    if (!done) throw new NotFoundException();
    return ok(done);
  }
}
