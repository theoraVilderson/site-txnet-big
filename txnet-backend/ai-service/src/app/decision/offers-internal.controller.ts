import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ok, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { OfferRefused, Offers, offerBodySchema, offerPatchSchema } from './offers';

const listSchema = z.object({ tenantId: z.string().uuid() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', '));
  return parsed.data;
}

/** A refusal is its reason: 404 for an offer not the tenant's, 400 for a target it may not use. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof OfferRefused)) throw err;
    throw err.reason === 'offer_not_found' ? new NotFoundException(err.reason) : new BadRequestException(err.reason);
  }
}

/**
 * The seams the reseller's AI page (F-038-j) reaches to make, edit and list
 * its offers (F-038-f1, ADR-0110). The caller has already checked the admin
 * may change the tenant's AI settings and passes who did. Service callers
 * only; anyone else gets a neutral 404.
 */
@TenantCapability('system')
@Controller('api/internal/ai/offers')
@UseGuards(ServiceOnlyGuard)
export class OffersInternalController {
  constructor(private readonly offers: Offers) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = parse(offerBodySchema, body);
    return ok({ offer: await refusing(() => this.offers.create(input)) });
  }

  @Post('list')
  @HttpCode(200)
  async list(@Body() body: unknown) {
    const { tenantId } = parse(listSchema, body);
    return ok({ items: await this.offers.list(tenantId) });
  }

  @Patch(':offerId')
  @HttpCode(200)
  async update(@Param('offerId', ParseUUIDPipe) offerId: string, @Body() body: unknown) {
    const patch = parse(offerPatchSchema, body);
    return ok({ offer: await refusing(() => this.offers.update(offerId, patch)) });
  }
}
