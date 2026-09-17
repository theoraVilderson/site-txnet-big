import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * The second pool: every tenant's rows, by policy (F-035-c).
 *
 * `notification_campaign` lets a tenant's connection read platform-wide rows
 * and write only its own (RLS shape B), so a platform-wide campaign cannot be
 * written on the app pool by anyone — `billing-service`'s coupon management hit
 * the same wall, and this is its answer. It connects as
 * `DATABASE_CROSS_TENANT_URL` (`txnet_cross_tenant_user`, `cross_tenant` policy
 * `USING (true)`, no `BYPASSRLS`) and is not extended with `withTenant`.
 *
 * **Injecting it is the audit.** `grep -rn CrossTenantPrismaService` in this
 * service lists `CampaignAdminService` and nothing else; that class's tenant
 * filter is the isolation. Widen the list only with a reason in a doc comment.
 */
@Injectable()
export class CrossTenantPrismaService extends PrismaService {}
