import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ok, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';
import { z } from 'zod';

import { offerHttpError } from '../envelope';
import { OfferRefused, Offers, offerFieldsSchema, offerPatchSchema, oneTarget } from '../decision/offers';
import { OutcomeRun, REPORT_MAX_DAYS } from '../decision/outcome-run';
import { identityOf } from '../request/identity.middleware';
import { AiAdminSettings, settingsPatchSchema } from './ai-admin-settings';
import { AiManageGuard } from './ai-manage.guard';
import { AT_RISK_KINDS, AtRisk } from './at-risk';
import { Margins } from './margins';
import { PlanLayout } from './plan-layout';
import { RESELLER_FORECAST_KINDS, ResellerForecasts } from './reseller-forecast';
import { UsageReport } from './usage-report';

const DAY_MS = 86_400_000;
const AT_RISK_PAGE_MAX = 100;

/** An offer as the page sends it: no tenant, no author — both are the gate's. */
export const adminOfferSchema = offerFieldsSchema.strict().refine(oneTarget, 'exactly one of couponTemplateId, variantId');
const adminOfferPatchSchema = offerPatchSchema.omit({ tenantId: true }).strict();
/** F-038-o5: whose suggestions the uplift report measures — the tenant's users, or the platform's resellers. */
export const UPLIFT_SUBJECTS = ['users', 'resellers'] as const;
const reportSchema = z
  .object({ from: z.coerce.date(), to: z.coerce.date(), subjects: z.enum(UPLIFT_SUBJECTS).default('users') })
  .strict()
  .refine((b) => b.to > b.from && b.to.getTime() - b.from.getTime() <= REPORT_MAX_DAYS * DAY_MS, { path: ['to'] });
const atRiskQuery = z.object({
  kind: z.enum(AT_RISK_KINDS),
  cursor: z.string().uuid().optional(),
  take: z.coerce.number().int().min(1).max(AT_RISK_PAGE_MAX).default(50),
});

const resellersQuery = z.object({
  kind: z.enum(RESELLER_FORECAST_KINDS),
  cursor: z.string().uuid().optional(),
  take: z.coerce.number().int().min(1).max(AT_RISK_PAGE_MAX).default(50),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', '));
  return parsed.data;
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof OfferRefused)) throw err;
    throw offerHttpError(err);
  }
}

/**
 * The reseller's AI admin (F-038-j1; the page is F-038-j2), through Traefik
 * behind `my-auth` and `ai.manage`. **The tenant is the gate's `X-Tenant-Id`
 * and the author its `X-User-Id`** — no body or query names either, and a
 * body that tries is refused (`.strict()`). Reads are `read`; writes the
 * default `staffWrite`, so a suspended reseller reads its page and changes
 * nothing (C-11).
 */
@Controller('api/ai/admin')
@UseGuards(AiManageGuard)
export class AiAdminController {
  constructor(
    private readonly settings: AiAdminSettings,
    private readonly atRisk: AtRisk,
    private readonly outcomes: OutcomeRun,
    private readonly offers: Offers,
    private readonly margins: Margins,
    private readonly layout: PlanLayout,
    private readonly resellers: ResellerForecasts,
    private readonly usage: UsageReport,
  ) {}

  @Get('settings')
  async readSettings(@Req() req: Request) {
    return ok({ settings: await this.settings.read(identityOf(req).tenantId) });
  }

  @Put('settings')
  @HttpCode(200)
  async writeSettings(@Req() req: Request, @Body() body: unknown) {
    const { tenantId, userId } = identityOf(req);
    return ok({ settings: await this.settings.write(tenantId, userId, parse(settingsPatchSchema, body)) });
  }

  @Get('at-risk')
  async listAtRisk(@Req() req: Request, @Query() query: unknown) {
    const { kind, cursor, take } = parse(atRiskQuery, query);
    return ok(await this.atRisk.list(identityOf(req).tenantId, kind, cursor ?? null, take, new Date()));
  }

  /** F-1528: each plan's price against its cost at the package's rate now; a losing plan flagged. */
  @Get('margins')
  async listMargins(@Req() req: Request) {
    return ok(await this.margins.report(identityOf(req).tenantId, new Date()));
  }

  /** F-1527: each plan family's use per period, and the plans the distribution says to add or reconsider. */
  @Get('plan-layout')
  async planLayout(@Req() req: Request) {
    return ok(await this.layout.report(identityOf(req).tenantId, new Date()));
  }

  /** F-038-o2: the platform owner's resellers by quota run-out or churn risk; anyone else 403 `not_platform_owner`. */
  @Get('resellers')
  async listResellers(@Req() req: Request, @Query() query: unknown) {
    const { kind, cursor, take } = parse(resellersQuery, query);
    return ok(await this.resellers.list(identityOf(req).tenantId, kind, cursor ?? null, take));
  }

  /** F-1525-a: the tenant's own use per meter over the next 30 days, and its billing wallet at its wholesale rate. */
  @Get('usage-forecast')
  async usageForecast(@Req() req: Request) {
    return ok(await this.usage.forecast(identityOf(req).tenantId, new Date()));
  }

  /** F-1525-a: every tenant's meters summed, for capacity — the platform owner only; anyone else 403 `not_platform_owner`. */
  @Get('capacity')
  async capacity(@Req() req: Request) {
    return ok(await this.usage.capacity(identityOf(req).tenantId, new Date()));
  }

  @Post('reports/uplift')
  @HttpCode(200)
  @TenantCapability('read')
  async uplift(@Req() req: Request, @Body() body: unknown) {
    const { from, to, subjects } = parse(reportSchema, body);
    const { tenantId } = identityOf(req);
    // F-038-o5: the platform's suggestions to its resellers — the platform owner's alone.
    if (subjects === 'resellers') await this.resellers.assertPlatformOwner(tenantId);
    return ok(await this.outcomes.report(tenantId, from, to, subjects === 'resellers' ? 'tenant' : 'user'));
  }

  @Get('offers')
  async listOffers(@Req() req: Request) {
    return ok({ items: await this.offers.list(identityOf(req).tenantId) });
  }

  @Post('offers')
  @HttpCode(201)
  async createOffer(@Req() req: Request, @Body() body: unknown) {
    const { tenantId, userId } = identityOf(req);
    const fields = parse(adminOfferSchema, body);
    return ok({ offer: await refusing(() => this.offers.create({ ...fields, tenantId, createdByUserId: userId })) });
  }

  @Patch('offers/:offerId')
  @HttpCode(200)
  async updateOffer(@Req() req: Request, @Param('offerId', ParseUUIDPipe) offerId: string, @Body() body: unknown) {
    const patch = parse(adminOfferPatchSchema, body);
    return ok({ offer: await refusing(() => this.offers.update(offerId, { ...patch, tenantId: identityOf(req).tenantId })) });
  }
}
