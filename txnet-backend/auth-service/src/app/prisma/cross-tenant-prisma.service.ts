import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * The second connection pool: every tenant's rows, by policy (F-066-m-b,
 * catalog 20.2 layer 1 / F-1202).
 *
 * Some reads legitimately happen *before* a tenant exists to scope them to,
 * because the read is what resolves the tenant. Which tenant owns this host
 * (`tenant_domain`), which bot owns this webhook path (`bot_integration`),
 * which DEK unwraps this credential (`tenant_dek`) — none of those can be asked
 * inside a scope, since the answer is the scope. `runAcrossTenants()` used to
 * mark them; it marked them on the *same* connection, which since F-066-m-a
 * means a connection every RLS policy now shows nothing to.
 *
 * So the escape becomes a pool instead of a flag. This client connects as
 * `DATABASE_CROSS_TENANT_URL` — the login role `txnet_cross_tenant_user`, whose
 * `cross_tenant` policy is `USING (true)`.
 *
 * **A policy, never a bypass.** Neither login role carries `BYPASSRLS`; this one
 * sees every row because a row in `pg_policy` says so. That is what makes
 * F-1202's "bypassing RLS on the normal pool is not possible" a property of the
 * database rather than of the code that talks to it — there is no connection
 * string in this system that turns the rules off, only one that is granted
 * different ones. It is also why the difference is auditable: `\d+` on a table
 * names both policies, and revoking the escape for one table is a `DROP POLICY`
 * rather than a code change.
 *
 * **What is deliberately absent: `withTenant`.** The extension is not applied
 * here, and must not be. Applying it would make every query on a registered
 * model demand an ambient tenant and bind `app.tenant_id` — which is precisely
 * the thing the callers of this client cannot do yet. The two clients differ in
 * exactly two ways, the URL and the extension, and both differences point the
 * same way.
 *
 * **Injecting this is the audit.** `runAcrossTenants` was one greppable symbol;
 * this class is the same, with a compiler behind it —
 * `grep -rn CrossTenantPrismaService` lists every place in this service that
 * can read across tenants, and a constructor is harder to add by accident than
 * a callback is. Never add a third client; widen this one's callers instead,
 * and say in the constructor's own doc comment why the read cannot be scoped.
 *
 * It extends `PrismaService` rather than `PrismaClient` so that a collaborator
 * typed against `PrismaService` accepts either one — the vault and the bot
 * directory take this client and are otherwise unchanged — while staying a
 * distinct Nest injection token.
 */
@Injectable()
export class CrossTenantPrismaService extends PrismaService {}
