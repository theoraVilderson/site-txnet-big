import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * The second pool: every tenant's rows, by policy (ADR-0024, F-092-j).
 *
 * **Injecting it is the audit**, and in this service the list is one reader:
 * `MeteringService.configsOf`, which turns the `configId` on a delta into the
 * tenant, the Grant and the remote client that delta belongs to. That read
 * cannot be scoped, for the reason `billing-service`'s copy of this class gives
 * about a bank's callback: the answer *is* the scope. A pass over a
 * platform-owned panel carries no `tenantId` at all (network invariant 9), and
 * on the application pool `config`'s policy shows no rows to a connection with
 * no `app.tenant_id` bound — so the lookup would answer "no such config" for
 * every config on the platform, and every byte would be written down as
 * unattributed.
 *
 * A policy, never a bypass: it connects as `DATABASE_CROSS_TENANT_URL`, the
 * login role `txnet_cross_tenant_user`, whose `cross_tenant` policy is
 * `USING (true)`; neither login role holds `BYPASSRLS`. It is deliberately not
 * extended with `withTenant`, which would demand the tenant this client exists
 * to find. Nothing is written through it — the writes go back through
 * `PrismaService` under the tenant this read produced.
 */
@Injectable()
export class CrossTenantPrismaService extends PrismaService {}
