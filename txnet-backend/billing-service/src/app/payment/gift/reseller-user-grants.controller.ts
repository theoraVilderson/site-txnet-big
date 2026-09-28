import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { EntitlementRefused, EntitlementRejection } from '../../entitlement/grant';
import { ConfigActionRefused } from '../../traffic/config-actions';
import { SpeedCapRefused } from '../../traffic/grant-speed';
import type { AdminConfigCommand } from '../../traffic/user-configs';
import { AdminConfigActionBody, adminConfigActionSchema } from '../../traffic/user-configs.schema';
import { GrantHistoryQuery, grantHistorySchema, GrantReasonBody, grantReasonSchema } from './grant-audit.schema';
import { GrantDeleteBody, grantDeleteSchema } from './grant-delete.schema';
import { GrantDevicesBody, grantDevicesSchema } from './grant-devices.schema';
import { GrantDurationBody, grantDurationSchema } from './grant-duration.schema';
import { GrantFreezeBody, grantFreezeSchema } from './grant-freeze.schema';
import { GrantIssueBody, grantIssueSchema } from './grant-issue.schema';
import { GrantListQuery, grantListSchema } from './grant-list.schema';
import { GrantRenewBody, grantRenewSchema } from './grant-renew.schema';
import { GrantSpeedBody, grantSpeedSchema } from './grant-speed.schema';
import {
  bytesOfGb,
  GrantTrafficBody,
  GrantTrafficGiftBody,
  grantTrafficGiftSchema,
  GrantTrafficResetBody,
  grantTrafficResetSchema,
  grantTrafficSchema,
} from './grant-traffic.schema';
import {
  ResellerUserGrantsRefused,
  ResellerUserGrantsRejection,
  ResellerUserGrantsService,
} from './reseller-user-grants.service';

const E = BackendI18nKeys.errors.billing;

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerUserGrantsRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  user_not_found: 404,
};

/** A freeze's (F-311-h), a change of days' (F-311-i), of traffic's (F-311-j, F-311-k, F-311-l), a delete's (F-311-m), an issue's (F-311-o) and a renewal's (F-311-d) refusals; any other `EntitlementRefused` is not this surface's and passes through. */
const GRANT_ACTION_STATUS: Partial<Record<EntitlementRejection, 400 | 409>> = {
  grant_not_active: 409,
  grant_not_frozen: 409,
  grant_moved: 409,
  freeze_until_not_future: 400,
  grant_closed: 409,
  grant_permanent: 409,
  duration_end_not_future: 400,
  duration_unchanged: 400,
  traffic_not_adjustable: 409,
  quota_below_zero: 400,
  nothing_to_reset: 409,
  grant_not_metered: 409,
  variant_not_assignable: 409,
  variant_not_deliverable: 409,
  metered_rate_missing: 409,
  metered_rate_not_positive: 409,
  request_reused: 409,
  already_issued: 409,
  grant_not_renewable: 409,
  traffic_not_renewable: 409,
  nothing_to_renew: 400,
  plan_period_unknown: 409,
  already_renewed: 409,
  devices_unchanged: 400,
};

/** One bucket for all four: expanding one Grant asks three of them at once. */
const readLimit = RateLimit({
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_GRANTS_READ, identityOf(req).userId),
  configKey: 'RESELLER_USER_GRANTS_READ_RATE_LIMIT',
  windowSec: 900,
});

/** Per request, not per config: one request is 1..50 configs. */
const actionLimit = RateLimit({
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_CONFIG_ACTION, identityOf(req).userId),
  configKey: 'RESELLER_USER_CONFIG_ACTION_RATE_LIMIT',
  windowSec: 900,
});

/**
 * An admin reads one user's services (F-311-f): the owner's four reads —
 * Grant list, a Grant's configs, its 30-day usage, its `/sub` link — for a
 * user of the reseller the **path** names. The data half of the panel's and
 * the bot's user sheet (F-311-v, F-311-y). And their config actions
 * (F-311-g): regenerate, disable, enable, retire, move — 1..50 ids, one
 * outcome per id, always 200, as on the owner's route.
 *
 * **No permission guard**, as on every reseller-named surface: `ResellerAccess`
 * is the door, inside the service. **The tenant is the path's**: the owner's
 * session carries the platform's `X-Tenant-Id` (ADR-0059).
 */
@Controller('billing/tenants/:tenantId/users/:userId')
export class ResellerUserGrantsController {
  constructor(private readonly service: ResellerUserGrantsService) {}

  @Get('grants')
  @readLimit
  grants(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query(new ZodValidationPipe(grantListSchema)) query: GrantListQuery,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.service.grants(actorOf(req), tenantId, userId, query));
  }

  @Get('grants/:grantId/configs')
  @readLimit
  async configs(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Req() req: Request,
  ) {
    return { grantId, rows: await this.refusing(() => this.service.configs(actorOf(req), tenantId, userId, grantId)) };
  }

  @Get('grants/:grantId/usage')
  @readLimit
  async usage(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Req() req: Request,
  ) {
    return { grantId, ...(await this.refusing(() => this.service.usage(actorOf(req), tenantId, userId, grantId))) };
  }

  /** Read only: resetting the link is `rotate-token`, below (F-311-n). */
  @Get('grants/:grantId/subscription-link')
  @readLimit
  async subscriptionLink(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Req() req: Request,
  ) {
    const subscriptionUrl = await this.refusing(() => this.service.subscriptionLink(actorOf(req), tenantId, userId, grantId));
    return { grantId, subscriptionUrl };
  }

  /**
   * This Grant's history (F-311-r): every admin act on it and on its configs —
   * who, when, before, after, why — newest first. The reads' bucket.
   */
  @Get('grants/:grantId/history')
  @readLimit
  async history(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Query(new ZodValidationPipe(grantHistorySchema)) query: GrantHistoryQuery,
    @Req() req: Request,
  ) {
    const page = { page: query.page ?? 1, pageSize: query.pageSize ?? 20 };
    return { grantId, ...(await this.refusing(() => this.service.history(actorOf(req), tenantId, userId, grantId, page))) };
  }

  /**
   * An admin resets this Grant's `/sub` link (F-311-n): the old one stops at
   * once and the new one is answered — never a bare key. The config actions'
   * bucket, not the owner's `GRANT_ROTATE_TOKEN`: that one is the user's own.
   */
  @Post('grants/:grantId/rotate-token')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async rotateToken(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantReasonSchema)) body: GrantReasonBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const subscriptionUrl = await this.refusing(() => this.service.rotateLink(adminOf(req, ip), tenantId, userId, grantId, body.reason ?? null));
    return { grantId, subscriptionUrl };
  }

  /** Always 200 with one outcome per config; a refusal of the door, the user or the body is the request's. */
  @Post('configs/actions')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async act(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(adminConfigActionSchema)) body: AdminConfigActionBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return { action: body.action, results: await this.refusing(() => this.service.act(adminOf(req, ip), tenantId, userId, body as AdminConfigCommand)) };
  }

  /**
   * An admin freezes one of this user's Grants (F-311-h): its configs off, its
   * clock stopped, kept — never purged. `until` unfreezes it by itself.
   * The config actions' bucket: both are an admin's writes on a user's service.
   */
  @Post('grants/:grantId/freeze')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async freeze(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantFreezeSchema)) body: GrantFreezeBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const until = body.until ? new Date(body.until) : null;
    const done = await this.refusing(() => this.service.freeze(adminOf(req, ip), tenantId, userId, grantId, until, body.reason ?? null));
    return { grantId, frozenUntil: done.frozenUntil?.toISOString() ?? null, configsDisabled: done.configsDisabled };
  }

  /** And unfreezes it: its end moves by the time it stood still. */
  @Post('grants/:grantId/unfreeze')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async unfreeze(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantReasonSchema)) body: GrantReasonBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const done = await this.refusing(() => this.service.unfreeze(adminOf(req, ip), tenantId, userId, grantId, body.reason ?? null));
    return { grantId, endsAt: done.endsAt?.toISOString() ?? null, configsRestored: done.configsRestored };
  }

  /**
   * An admin changes this Grant's days (F-311-i): `days` (±N from the end it
   * has) or `endsAt`, and the `reason` its history keeps. A closed Grant is a
   * renewal's, not a date's.
   */
  @Post('grants/:grantId/duration')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async duration(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantDurationSchema)) body: GrantDurationBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const change = body.endsAt !== undefined ? { endsAt: new Date(body.endsAt) } : { days: body.days as number };
    const done = await this.refusing(() => this.service.changeDuration(adminOf(req, ip), tenantId, userId, grantId, change, body.reason));
    return { grantId, changeId: done.changeId, endsAtBefore: done.endsAtBefore.toISOString(), endsAtAfter: done.endsAtAfter.toISOString(), revived: done.revived };
  }

  /**
   * An admin changes this Grant's traffic (F-311-j): `gb` (± GiB) and the
   * `reason` its adjustment row keeps. `spent` says the new Quota is at or
   * below what was used: the planner closes it and it is suspended from there.
   */
  @Post('grants/:grantId/traffic')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async traffic(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantTrafficSchema)) body: GrantTrafficBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const done = await this.refusing(() => this.service.changeTraffic(adminOf(req, ip), tenantId, userId, grantId, bytesOfGb(body.gb), body.reason));
    return {
      grantId,
      adjustmentId: done.adjustmentId,
      purchasedBytesBefore: done.purchasedBytesBefore.toString(),
      purchasedBytesAfter: done.purchasedBytesAfter.toString(),
      usedBytes: done.usedBytes.toString(),
      spent: done.spent,
      revived: done.revived,
    };
  }

  /**
   * An admin resets this Grant's traffic (F-311-k): the full bag is left
   * again. Quota rises by `resetBytes`, what was used since the last reset;
   * the meter is never zeroed.
   */
  @Post('grants/:grantId/traffic/reset')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async resetTraffic(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantTrafficResetSchema)) body: GrantTrafficResetBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const done = await this.refusing(() => this.service.resetTraffic(adminOf(req, ip), tenantId, userId, grantId, body.reason));
    return {
      grantId,
      adjustmentId: done.adjustmentId,
      purchasedBytesBefore: done.purchasedBytesBefore.toString(),
      purchasedBytesAfter: done.purchasedBytesAfter.toString(),
      usedBytes: done.usedBytes.toString(),
      resetBytes: done.resetBytes.toString(),
      spent: done.spent,
      revived: done.revived,
    };
  }

  /**
   * An admin gifts bytes to this metered Grant (F-311-l): `gb` (> 0 GiB) and
   * the `reason` its adjustment row keeps. No wallet debit; the remainder
   * credit at close never pays them back as money.
   */
  @Post('grants/:grantId/traffic/gift')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async giftTraffic(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantTrafficGiftSchema)) body: GrantTrafficGiftBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const done = await this.refusing(() => this.service.giftTraffic(adminOf(req, ip), tenantId, userId, grantId, bytesOfGb(body.gb), body.reason));
    return {
      grantId,
      adjustmentId: done.adjustmentId,
      purchasedBytesBefore: done.purchasedBytesBefore.toString(),
      purchasedBytesAfter: done.purchasedBytesAfter.toString(),
      usedBytes: done.usedBytes.toString(),
      revived: done.revived,
    };
  }

  /**
   * An admin sets this Grant's speed cap (F-311-p): `mbps` both ways, or
   * `null` to lift it. **409** `rate_limit_unsupported` names the panels that
   * cannot hold one; `no_configs` is a Grant with nothing placed yet.
   */
  @Post('grants/:grantId/speed')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async setSpeed(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantSpeedSchema)) body: GrantSpeedBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.service.setSpeed(adminOf(req, ip), tenantId, userId, grantId, body.mbps, body.reason));
  }

  /**
   * An admin sets this Grant's device limit (F-311-q), or lifts it with
   * `null`. Never refused by a panel: `panelsNotEnforcing` names the ones that
   * cannot hold it.
   */
  @Post('grants/:grantId/devices')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async setDevices(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantDevicesSchema)) body: GrantDevicesBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.service.setDevices(adminOf(req, ip), tenantId, userId, grantId, body.limit, body.reason));
  }

  /**
   * An admin deletes this Grant (F-311-m): `cancelled`, every config released
   * from its panel now rather than after the purge window, rows kept. `refund`
   * is the admin's answer for the unserved remainder (F-027-r); `refundSkipped`
   * says why a refund asked for credited nothing (a prepaid Grant, all served).
   */
  @Post('grants/:grantId/delete')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async deleteGrant(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantDeleteSchema)) body: GrantDeleteBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const done = await this.refusing(() => this.service.deleteGrant(adminOf(req, ip), tenantId, userId, grantId, body.refund, body.reason));
    return { grantId, ...done };
  }

  /**
   * An admin issues this user a service by hand (F-311-o): an `admin_grant`
   * Grant of `variantId`, active at once and placed like a purchase, no
   * invoice. `requestId` makes a repeat answer the first Grant (`issued: false`).
   */
  @Post('grants')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async issue(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(grantIssueSchema)) body: GrantIssueBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const done = await this.refusing(() => this.service.issue(adminOf(req, ip), tenantId, userId, body.variantId, body.requestId, body.reason ?? null));
    return { ...done, startsAt: done.startsAt.toISOString(), endsAt: done.endsAt?.toISOString() ?? null };
  }

  /**
   * An admin renews this Grant in place (F-311-d): one period of the plan the
   * user bought, or `gb` / `days` typed; `admin_grant`, no money. `requestId`
   * makes a repeat answer the first renewal (`renewed: false`).
   */
  @Post('grants/:grantId/renew')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async renew(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantRenewSchema)) body: GrantRenewBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const typed = body.gb !== undefined || body.days !== undefined;
    const amount = typed ? { bytes: bytesOfGb(body.gb ?? 0), days: body.days ?? 0 } : undefined;
    const done = await this.refusing(() => this.service.renew(adminOf(req, ip), tenantId, userId, grantId, { requestId: body.requestId, reason: body.reason ?? null, amount }));
    return {
      ...done,
      bytes: done.bytes.toString(),
      forgivenBytes: done.forgivenBytes.toString(),
      purchasedBytesBefore: done.purchasedBytesBefore.toString(),
      purchasedBytesAfter: done.purchasedBytesAfter.toString(),
      endsAtBefore: done.endsAtBefore?.toISOString() ?? null,
      endsAtAfter: done.endsAtAfter?.toISOString() ?? null,
    };
  }

  /**
   * The door's refusals travel as `reason`, as on the other reseller surfaces;
   * a missing Grant is the owner routes' own 404. The link's two 409s
   * (`SubscriptionLinkService`) are already HTTP errors and pass through.
   */
  private async refusing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConfigActionRefused && e.reason === 'grant_not_found') {
        throw new NotFoundException({ i18nKey: E.grant.notFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      if (e instanceof SpeedCapRefused) {
        throw new ConflictException({ reason: e.reason, panels: e.panels, message: e.message });
      }
      if (e instanceof EntitlementRefused) {
        const payload = { reason: e.reason, message: e.message };
        if (e.reason === 'grant_not_found') throw new NotFoundException({ i18nKey: E.grant.notFound, ...payload });
        if (e.reason === 'variant_not_found') throw new NotFoundException({ i18nKey: E.invoice.variantNotFound, ...payload });
        if (GRANT_ACTION_STATUS[e.reason] === 400) throw new BadRequestException(payload);
        if (GRANT_ACTION_STATUS[e.reason] === 409) throw new ConflictException(payload);
        throw e;
      }
      if (!(e instanceof ResellerUserGrantsRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        default:
          throw new ConflictException(payload);
      }
    }
  }
}

const actorOf = (req: Request) => {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
};

/** A write's actor also carries the address its audit row keeps (F-311-r). */
const adminOf = (req: Request, ip: string) => ({ ...actorOf(req), ip });
