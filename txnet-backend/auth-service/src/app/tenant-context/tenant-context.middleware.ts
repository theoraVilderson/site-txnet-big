import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { resolveTenant } from '../tenant/tenant';
import { runWithTenant } from './tenant-context';

/**
 * Opens the ambient tenant scope for the rest of the request (ADR-0024).
 *
 * It runs `next()` *inside* the `AsyncLocalStorage` scope, so every guard,
 * pipe, handler and service the request reaches afterwards can read
 * `TenantContext.current()` without being handed anything.
 *
 * **Ordering: it is registered immediately after `TenantMiddleware`**, whose
 * answer it reads via `resolveTenant(req)`. The scope is entered here rather
 * than inside `TenantMiddleware` itself for one structural reason: this unit
 * already depends on `tenant` for `ResolvedTenant` and the resolution, and
 * having `tenant`'s middleware call into this unit would make the two units
 * depend on each other. One edge, one direction (§8).
 *
 * An unresolved tenant still opens a scope, carrying `null`. "Resolved to
 * nothing" and "nobody ever opened a scope" are different failures and the
 * second one — a detached timer, a queue consumer written later — is the one
 * that must be loud (ADR-0024's accepted cost).
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    runWithTenant(resolveTenant(req), () => next());
  }
}
