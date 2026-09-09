import { SetMetadata } from '@nestjs/common';

export const TENANT_AGNOSTIC = 'tenantAgnostic';

/**
 * Marks the one kind of route that legitimately runs with no tenant resolved:
 * a route whose *job* is to work out which tenant a request belongs to.
 *
 * `TenantGuard` is global on purpose — the routes that would remember to opt
 * in are the ones that already think about tenancy, and the leak is in the
 * ones that do not (ADR-0024 decision 4). This is the exception that the
 * global shape cannot express: `bot-service` asks which tenant a webhook path
 * names, and it asks precisely because nobody knows yet. Requiring a tenant
 * there would make the answer a prerequisite for the question.
 *
 * Two rules, and neither is optional:
 *
 * 1. **Every route carrying this must also carry `ServiceOnlyGuard`.** What is
 *    given up here is the tenancy check, so what has to replace it is a
 *    stronger caller check, not a weaker one.
 * 2. **It is greppable, like `runAcrossTenants`** — `grep -rn TenantAgnostic`
 *    is the audit, and the list it returns is meant to stay short enough to
 *    read. Widen an existing route before adding a second one.
 */
export const TenantAgnostic = () => SetMetadata(TENANT_AGNOSTIC, true);
