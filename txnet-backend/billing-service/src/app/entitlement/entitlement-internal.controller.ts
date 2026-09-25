import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { DeliverDueResult, DeliveryOutcome, GrantDeliveryService } from './delivery';
import { GrantPurgeService, PurgeResult } from './purge';

/**
 * The seam `worker-service` reaches the purge clock through (F-027-y).
 *
 * The rule is entitlement's — which Grants are past their window, and what
 * "past" resolves to across a Grant override and a tenant default — and it
 * lives where this service's two pools are, because the scan is cross-tenant
 * and every write is not. `worker-service` owns *when*, not *what*: it holds
 * the hourly tick and asks here, exactly as `deposit-expiry.job.ts` asks the
 * payment sweep and `vault-retention.job.ts` asks tenant-service.
 *
 * **Outside the gate and outside the tenant.** `/api/internal/*` is not under
 * the `PathPrefix(/api/billing)` Traefik router, so nothing reaches it from
 * the edge, and `IdentityMiddleware` excludes it — a queue consumer carries no
 * `X-User-Id` and no tenant, and the sweep resolves every tenant it touches
 * itself. `ServiceOnlyGuard` stands in for both, refused as a neutral 404.
 *
 * **Safe to run twice** (ADR-0027): the scan skips Grants whose configs are
 * already `absent`, so a second call inside the same hour purges nothing and
 * answers zero.
 */
@TenantCapability('system')
@Controller('internal/billing/entitlement')
@UseGuards(ServiceOnlyGuard)
export class EntitlementInternalController {
  constructor(
    private readonly purge: GrantPurgeService,
    private readonly delivery: GrantDeliveryService,
  ) {}

  /**
   * Set `desiredRemote = absent` on every config of every suspended Grant past
   * its `purgeAfterDays`, one batch, releasing the panel seats.
   *
   * Answers the raw counts rather than this service's usual envelope, for the
   * reason the deposit seam gives: the only caller is a job that records them
   * in `bot_execution_log` and treats an answer it cannot read as a failed run.
   */
  @Post('purge-due')
  @HttpCode(200)
  purgeDue(): Promise<PurgeResult> {
    return this.purge.purgeDue();
  }

  /**
   * One check of every paid Grant whose delivery is due (F-111-d, spec §5.8
   * step 3): delivered, pushed to its next retry, or — past the last one, or
   * with no handler for its kind — cancelled and its invoice refunded in full.
   * Safe to run twice: every write is conditional on `pending`, and a Grant
   * checked is not due again until its `nextDeliveryAt`.
   */
  @Post('deliver-due')
  @HttpCode(200)
  deliverDue(): Promise<DeliverDueResult> {
    return this.delivery.deliverDue();
  }

  /**
   * The same check for one Grant, the moment its purchase is announced
   * (F-114-i). Checked only while `pending` and due, so a repeat answers
   * `skipped`; the answer is `{ outcome }` in the usual envelope.
   */
  @Post('grants/:grantId/deliver')
  @HttpCode(200)
  async deliverNow(@Param('grantId', new ParseUUIDPipe()) grantId: string): Promise<{ outcome: DeliveryOutcome }> {
    return { outcome: await this.delivery.deliverNow(grantId) };
  }
}
