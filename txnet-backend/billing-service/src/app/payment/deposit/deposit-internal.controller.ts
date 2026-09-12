import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard } from '@txnet-backend/shared-core';

import { DepositExpiryResult, DepositExpiryService } from './deposit-expiry.service';

/**
 * The seam `worker-service` reaches billing through (F-092-k).
 *
 * The expiry sweep is billing's rule — one clock on a payment and its coupon
 * holds, released the word that says the clock ran out — and it lives where the
 * coupon SQL functions and this service's two pools are. `worker-service` owns
 * *when*, not *what*: it holds the tick, and asks over
 * `POST /api/internal/billing/deposit/expire-pending`, exactly as the vault
 * retention job asks `auth-service` (`domains/automation/contract.worker.md`).
 *
 * **Outside the gate and outside the tenant.** `/api/internal/*` is not under
 * the `PathPrefix(/api/billing)` Traefik router, so nothing reaches it from the
 * edge; `IdentityMiddleware` excludes it, because a queue consumer carries no
 * `X-User-Id` and no tenant — the sweep resolves every tenant it touches
 * itself. What stands in for both is `ServiceOnlyGuard`: the platform's own
 * `SERVICE_AUTH_TOKEN`, refused as a neutral 404.
 *
 * **Safe to run twice**, which an at-least-once tick (ADR-0027) requires: the
 * flip is guarded by the row's own status, so a second call inside the same
 * minute expires nothing and answers zero.
 */
@Controller('internal/billing/deposit')
@UseGuards(ServiceOnlyGuard)
export class DepositInternalController {
  constructor(private readonly expiry: DepositExpiryService) {}

  /**
   * Expire every `pending` payment past its `expiresAt`, one batch, and give
   * its coupon holds back.
   *
   * Answers the raw counts rather than this service's usual envelope: the only
   * caller is a job that records them in `bot_execution_log`, and it treats an
   * answer it cannot read as a failed run.
   */
  @Post('expire-pending')
  @HttpCode(200)
  expirePending(): Promise<DepositExpiryResult> {
    return this.expiry.expirePending();
  }
}
