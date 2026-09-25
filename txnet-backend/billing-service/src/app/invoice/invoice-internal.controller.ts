import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { InvoiceExpiryResult, InvoiceExpiryService } from './invoice-expiry.service';

/**
 * The seam `worker-service`'s `invoice_pending_expiry` job reaches (F-111-a):
 * `POST /api/internal/billing/invoices/expire-pending`. Outside the gate and
 * the tenant for the reasons `deposit-internal.controller.ts` gives;
 * `ServiceOnlyGuard` stands in for both. Safe to run twice — the flip is
 * guarded by the row's own status.
 */
@TenantCapability('system')
@Controller('internal/billing/invoices')
@UseGuards(ServiceOnlyGuard)
export class InvoiceInternalController {
  constructor(private readonly expiry: InvoiceExpiryService) {}

  @Post('expire-pending')
  @HttpCode(200)
  expirePending(): Promise<InvoiceExpiryResult> {
    return this.expiry.expirePending();
  }
}
