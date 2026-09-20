import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { TenantAccessActor, TenantAccessService, TenantAccessView } from './tenant-access.service';

/**
 * `GET /api/tenants/:id/access` (F-311-e): may the caller administer this
 * reseller, and may they change anything there.
 *
 * **It never refuses.** Every other reseller-named route maps the door's four
 * reasons onto 403/404/409, because there the refusal is the answer to "do
 * this". Here the refusal *is* the answer to "may I", so it arrives as a 200
 * with `canRead: false` and the reason in the body — a surface asking whether
 * to offer a screen must not have to read an error to find out, and a bot menu
 * must not fail because the chat is an ordinary customer.
 *
 * No `TenantPermissionGuard`, as on every reseller-named route: a reseller's
 * owner holds no operator permission, and `ResellerAccess` is the door
 * (invariant 21). A `read` by method, so a suspended reseller still gets its
 * answer — which is the answer that says it may no longer write.
 */
@Controller('tenants/:id/access')
export class TenantAccessController {
  constructor(private readonly access: TenantAccessService) {}

  @Get()
  verdict(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<TenantAccessView> {
    return this.access.verdict(actorOf(req), id);
  }
}

function actorOf(req: Request): TenantAccessActor {
  const identity = identityOf(req);
  return { userId: identity.userId, tenantId: identity.tenantId, permissions: identity.permissions };
}
