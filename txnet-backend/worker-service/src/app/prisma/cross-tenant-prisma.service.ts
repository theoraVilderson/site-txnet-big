import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * The second connection pool: every tenant's rows, by policy (F-067-q).
 *
 * A notice is told in the tenant its person lives in, and that is not always
 * the event's: a bought reseller's owner is a platform user (F-019-h), and
 * auth-service finds no one under the reseller's tenant. The read that answers
 * "which tenant is this user's" cannot itself be scoped — the answer *is* the
 * scope — and on the application pool `identity.user`'s RLS policy shows no
 * rows to a connection with no `app.tenant_id` bound.
 *
 * As in `auth-service`: **a policy, never a bypass** — this connects as
 * `DATABASE_CROSS_TENANT_URL` (`txnet_cross_tenant_user`, `cross_tenant`
 * policy `USING (true)`, no `BYPASSRLS`). **Injecting it is the audit**: in
 * this service the list is `TenantSubscriptionNoticeConsumer`, which reads one
 * column, `user.tenantId`. Widen it only with a reason written beside it.
 */
@Injectable()
export class CrossTenantPrismaService extends PrismaService {}
