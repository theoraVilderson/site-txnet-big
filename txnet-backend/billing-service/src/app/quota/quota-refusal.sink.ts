import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { recordQuotaRefusal, setQuotaRefusalSink } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/**
 * Where this service's refused quota acts are recorded (F-019-v8, ADR-0107
 * point 11; `shared-core` `quota-alerts.ts`). The act's transaction rolls
 * back, so the refusal — the day's refused units, and the "stopped" alert to
 * the reseller's owner — is written on a connection of its own.
 *
 * **Why the cross-tenant pool:** the write runs outside the act's transaction
 * and its tenant binding, and it names the reseller the engine reported,
 * never a value from the request. It touches only
 * `reseller_quota_refusal`, `reseller_quota_alert` and the outbox.
 */
@Injectable()
export class QuotaRefusalSink implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly all: CrossTenantPrismaService) {}

  onModuleInit(): void {
    setQuotaRefusalSink((r) => recordQuotaRefusal(this.all, r));
  }

  onModuleDestroy(): void {
    setQuotaRefusalSink(null);
  }
}
