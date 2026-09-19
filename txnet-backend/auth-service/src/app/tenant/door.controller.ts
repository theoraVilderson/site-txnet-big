import { Controller, Get, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';
import { ok } from '../common/response/response.util';
import { DoorProbe, doorServes } from './door';
import { resolveTenant } from './tenant';

/**
 * `GET /api/auth/door` — may the host that asked serve the panel? (F-066-x.)
 *
 * `{ serves: boolean }` and nothing else: no purpose, no gate, no tenant. The
 * panel needs a yes or a no, and a stranger learns no more from this than from
 * the page the panel then does or does not render.
 *
 * Public and unauthenticated — the first page load has no session — and asked
 * by `panel-web`'s proxy on every host it has not cached. A host that resolves
 * to no tenant never reaches this: `TenantGuard` answers it the neutral 404,
 * which the panel reads as "nothing to mirror" (F-066-u's own call).
 *
 * `system`, because it is the one capability no status closes: whether a door
 * is open is not something a terminated reseller should be refused an answer
 * to.
 */
@TenantCapability('system')
@DoorProbe()
@Controller('auth/door')
export class DoorController {
  @Get()
  @HttpCode(HttpStatus.OK)
  async door(@Req() req: Request) {
    const tenant = resolveTenant(req);
    return ok({ serves: tenant ? doorServes(tenant) : true });
  }
}
