import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { DeliverDueResult, DeliveryOutcome, GrantDeliveryService } from './delivery';
import { EndNoticeResult, GrantEndNoticeService } from './end-notice';
import { GrantIdleNoticeService, IdleNoticeResult } from './idle-notice';
import { GrantPurgeService, PurgeResult } from './purge';
import { GrantPurgeNoticeService } from './purge-notice';
import { GrantUnusedNoticeService, UnusedNoticeResult } from './unused-notice';

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
    private readonly unused: GrantUnusedNoticeService,
    private readonly ends: GrantEndNoticeService,
    private readonly purgeNotice: GrantPurgeNoticeService,
    private readonly idle: GrantIdleNoticeService,
  ) {}

  /**
   * Set `desiredRemote = absent` on every config of every suspended Grant past
   * its `purgeAfterDays`, one batch, releasing the panel seats — then tell
   * each suspended Grant whose purge is within a day (F-601-j, `told`). After,
   * not before: a Grant purged in this call is not told it will be.
   *
   * Answers the raw counts rather than this service's usual envelope, for the
   * reason the deposit seam gives: the only caller is a job that records them
   * in `bot_execution_log` and treats an answer it cannot read as a failed run.
   */
  @Post('purge-due')
  @HttpCode(200)
  async purgeDue(): Promise<PurgeResult & { told: number }> {
    const purged = await this.purge.purgeDue();
    const { told } = await this.purgeNotice.noticeDue();
    return { ...purged, told };
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
   * "Not connected yet?" (F-601-c): every active Grant whose `unusedCheckAt`
   * is due is checked once — told, moved to its next check, or cleared.
   * Safe to run twice: each write is conditional on the clock it read.
   */
  @Post('unused-due')
  @HttpCode(200)
  unusedDue(): Promise<UnusedNoticeResult> {
    return this.unused.noticeDue();
  }

  /**
   * "Trouble connecting?" (F-601-l): every active Grant whose `idleCheckAt`
   * is due is checked once — told or not, its clock is cleared until the
   * next consumed byte. Safe to run twice: the write is conditional on it.
   */
  @Post('idle-due')
  @HttpCode(200)
  idleDue(): Promise<IdleNoticeResult> {
    return this.idle.noticeDue();
  }

  /**
   * Time thresholds (F-601-e): every active Grant within 7 days of its end
   * whose clock is due, or was set for another end, is checked once — told,
   * or moved to its next level. Safe to run twice: each write is conditional
   * on the clock and the end it read.
   */
  @Post('end-due')
  @HttpCode(200)
  endDue(): Promise<EndNoticeResult> {
    return this.ends.noticeDue();
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
