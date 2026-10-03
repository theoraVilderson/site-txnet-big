import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * The second pool: every tenant's rows, by policy (F-033-k) — as
 * `billing-service`'s class, whose comment has the whole case. It connects as
 * `DATABASE_CROSS_TENANT_URL`, the login role `txnet_cross_tenant_user`, whose
 * `cross_tenant` policy is `USING (true)`; neither login role holds
 * `BYPASSRLS`, and `withTenant` is not applied.
 *
 * **Injecting it is the audit.** In this service the list is
 * `SupportLifecycle.closeIdle` alone: the idle sweep is a clock, asked by
 * worker-service over the internal seam, and no request carries a tenant to
 * scope it by. Widen the list only with a reason here.
 */
@Injectable()
export class CrossTenantPrismaService extends PrismaService {}
