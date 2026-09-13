import {
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
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { SettlementPermissionGuard } from './settlement-permission.guard';
import {
  CreateGrantBody,
  ListGrantsQuery,
  RecordPayoutBody,
  createGrantSchema,
  listGrantsSchema,
  recordPayoutSchema,
} from './settlement.schema';
import { Operator, SettlementRefused, SettlementRejection, SettlementService } from './settlement.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<SettlementRejection, 403 | 404 | 409> = {
  not_platform_owner: 403,
  gateway_not_found: 404,
  tenant_not_found: 404,
  grant_not_found: 404,
  grant_to_owner: 409,
  already_granted: 409,
  already_withdrawn: 409,
  amount_not_positive: 409,
  exceeds_outstanding: 409,
};

/**
 * The platform owner's settlement back office (ADR-0041 §5/§6, F-096-e):
 * `/api/billing/settlement/*`. The old `/api/billing/admin/settlement/*` still
 * answers as a deprecated alias until 2026-10-13 (F-098): a role word never
 * belongs in a URL, and the second door below is what makes this an operator
 * surface — never the path.
 *
 * Five routes, which is the whole of what ADR-0041 leaves to an operator: make
 * a grant, withdraw one, see them, see what is owed, and record the transfer
 * that discharges it. Everything they touch was built by F-096-a..d and, until
 * this row, was reachable only from a SQL client.
 *
 * **Why it is in `billing-service` and not beside the other operator routes.**
 * Every other admin surface on this platform lives in `auth-service`, which is
 * also the only writer of `admin_audit_log` today. The three settlement tables,
 * the money arithmetic and `isPlatformOwner` are all here, and moving the
 * routes would put the ledger's arithmetic outside the unit whose contract
 * states it. So this service writes its own audit rows instead — the one
 * generated Prisma client covers every schema, and `prisma.service.ts`'s "only
 * ever queries the billing models" is amended with this exception rather than
 * quietly broken.
 *
 * **Two doors, and the second is the real one.** `SettlementPermissionGuard`
 * wants `settlement.manage`; `SettlementService.assertOperator` wants the
 * caller's tenant to *be* the platform owner. A reseller can give itself the
 * first — it administers its own roles — and never the second. See the
 * service's class comment for what stands in for RLS here and what does not.
 *
 * **`tenantId` travels in the body on every write**, which is the opposite of
 * every other billing route. It is the *subject*, not the caller: who is
 * borrowing, who is being paid. The caller's own tenant still comes only from
 * the gate.
 */
@Controller(['billing/settlement', 'billing/admin/settlement'])
@UseGuards(SettlementPermissionGuard)
export class SettlementController {
  constructor(private readonly settlement: SettlementService) {}

  /** Who is acting, entirely from the gate's headers and the socket. */
  private operator(req: Request, ip: string): Operator {
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId, ip };
  }

  /** Every grant, or one tenant's. */
  @Get('grants')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.SETTLEMENT_ADMIN_READ, identityOf(req).userId),
    configKey: 'SETTLEMENT_ADMIN_READ_RATE_LIMIT',
    windowSec: 900,
  })
  async grants(
    @Query(new ZodValidationPipe(listGrantsSchema)) query: ListGrantsQuery,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() =>
      this.settlement.listGrants(this.operator(req, ip), query.tenantId),
    );
  }

  /** Grant a gateway to a tenant that does not own it (ADR-0041 §1). */
  @Post('grants')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.SETTLEMENT_ADMIN_WRITE, identityOf(req).userId),
    configKey: 'SETTLEMENT_ADMIN_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  async grant(
    @Body(new ZodValidationPipe(createGrantSchema)) body: CreateGrantBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const grant = await this.refusing(() =>
      this.settlement.createGrant(
        {
          tenantId: body.tenantId,
          gatewayId: body.gatewayId ?? null,
          tenantGatewayConfigId: body.tenantGatewayConfigId ?? null,
          note: body.note ?? null,
        },
        this.operator(req, ip),
      ),
    );
    return { id: grant.id, tenantId: grant.tenantId, isActive: grant.isActive, grantedAt: grant.grantedAt };
  }

  /**
   * Withdraw a grant (ADR-0041 §6). A `POST` to a sub-path rather than a
   * `DELETE` on the grant, because the row is not deleted and never will be:
   * the payments taken under it still point at it.
   */
  @Post('grants/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.SETTLEMENT_ADMIN_WRITE, identityOf(req).userId),
    configKey: 'SETTLEMENT_ADMIN_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  async withdraw(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.settlement.withdrawGrant(id, this.operator(req, ip)));
  }

  /** What the platform owes each tenant, most owed first. */
  @Get('owed')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.SETTLEMENT_ADMIN_READ, identityOf(req).userId),
    configKey: 'SETTLEMENT_ADMIN_READ_RATE_LIMIT',
    windowSec: 900,
  })
  async owed(@Req() req: Request, @Ip() ip: string) {
    const rows = await this.refusing(() => this.settlement.owed(this.operator(req, ip)));
    // Decimals as strings on the wire, like every other money field this
    // service answers (C-02): a JSON number would round the ledger.
    return rows.map((r) => ({
      tenantId: r.tenantId,
      accrued: r.accrued.toFixed(2),
      paidOut: r.paidOut.toFixed(2),
      outstanding: r.outstanding.toFixed(2),
    }));
  }

  /** Record a transfer that already happened outside the system (ADR-0041 §5). */
  @Post('payouts')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.SETTLEMENT_ADMIN_WRITE, identityOf(req).userId),
    configKey: 'SETTLEMENT_ADMIN_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  async payout(
    @Body(new ZodValidationPipe(recordPayoutSchema)) body: RecordPayoutBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const payout = await this.refusing(() =>
      this.settlement.recordPayout(
        {
          tenantId: body.tenantId,
          amount: new Prisma.Decimal(body.amount),
          method: body.method ?? null,
          reference: body.reference ?? null,
          proofAttachmentKey: body.proofAttachmentKey ?? null,
          notes: body.notes ?? null,
        },
        this.operator(req, ip),
      ),
    );
    return {
      id: payout.id,
      tenantId: payout.tenantId,
      amount: payout.amount.toFixed(2),
      paidAt: payout.paidAt,
      proofAttachmentKey: payout.proofAttachmentKey,
    };
  }

  /**
   * One place that turns a refusal into a status, so a new reason cannot reach
   * a caller as a 500 by being added to the service and forgotten here — the
   * `STATUS` map above does not compile without it.
   *
   * The reason travels in the body. This is an operator surface, so naming the
   * rule that refused is the point; on a user-facing route it would be more
   * than the caller is owed.
   */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof SettlementRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      if (STATUS[e.reason] === 403) throw new ForbiddenException(payload);
      if (STATUS[e.reason] === 404) throw new NotFoundException(payload);
      throw new ConflictException(payload);
    }
  }
}
