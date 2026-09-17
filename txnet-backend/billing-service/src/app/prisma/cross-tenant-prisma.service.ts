import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * The second connection pool: every tenant's rows, by policy (F-092-j).
 *
 * `billing-service` had one pool and a comment saying it would never need
 * another, because the gate forwards the tenant on every route. F-092-j is the
 * route where that stops being true. A gateway callback is a **bank redirecting
 * a browser**: it carries no session and no `X-Tenant-Id`, so the tenant has to
 * be resolved from the Host it arrived on (ADR-0025) — and the read that
 * resolves it cannot itself be scoped, because the answer *is* the scope. On
 * the application pool `tenant.tenant_domain`'s RLS policy shows no rows to a
 * connection with no `app.tenant_id` bound, so that lookup would answer "no
 * such host" for every host on the platform.
 *
 * Everything true of `auth-service`'s class is true here, and is written out
 * there at length: it is **a policy, never a bypass** — this connects as
 * `DATABASE_CROSS_TENANT_URL`, the login role `txnet_cross_tenant_user`, whose
 * `cross_tenant` policy is `USING (true)`; neither login role holds
 * `BYPASSRLS`; and `withTenant` is deliberately **not** applied, since the
 * extension would demand the very tenant this client exists to find.
 *
 * **Injecting it is the audit.** `grep -rn CrossTenantPrismaService` lists
 * every reader on this platform that can see across tenants, and in this
 * service the list is `CallbackTenantMiddleware`, and — for the webhook door,
 * whose read finds a gateway's owner and a payment's tenant (ADR-0051) —
 * `WebhookGatewayMiddleware` and `DepositWebhookService`; and the platform
 * owner's admin surfaces (ADR-0053), among them `TenantBillingAdminService`,
 * which writes a reseller's billing wallet (F-019-a). Widen that list only
 * with a reason in a doc comment saying why the read cannot be scoped.
 */
@Injectable()
export class CrossTenantPrismaService extends PrismaService {}
