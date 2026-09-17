import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * The second pool: every tenant's rows, by policy (F-035-c).
 *
 * `notification_campaign` lets a tenant's connection read platform-wide rows
 * and write only its own (RLS shape B), so the platform owner's campaigns —
 * platform-wide or for another tenant — cannot be written on the app pool.
 * Only the platform owner is served here; a tenant admin stays on the app pool
 * with RLS behind them (ADR-0053). It connects as
 * `DATABASE_CROSS_TENANT_URL` (`txnet_cross_tenant_user`, `cross_tenant` policy
 * `USING (true)`, no `BYPASSRLS`) and is not extended with `withTenant`.
 *
 * **Injecting it is the audit.** `grep -rn CrossTenantPrismaService` in this
 * service lists `CampaignAdminService` and nothing else; its `access()` is the
 * one place that decides a caller is the platform owner. Widen the list only with a reason in a doc comment.
 */
@Injectable()
export class CrossTenantPrismaService extends PrismaService {}
