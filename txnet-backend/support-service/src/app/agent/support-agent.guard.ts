import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** The permission an agent's role holds (F-033-d, migration 20261003001300). */
export const SUPPORT_AGENT_PERMISSION = 'support.agent';

/**
 * The first door on `/api/support/agent/*` (F-033-d), like ai-service's
 * `AiManageGuard` and like it **not the boundary**: every route reads and
 * writes only the gate's tenant (`X-Tenant-Id`, RLS), and no body names one.
 */
@Injectable()
export class SupportAgentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, SUPPORT_AGENT_PERMISSION)) {
      throw new ForbiddenException(`${SUPPORT_AGENT_PERMISSION} is required`);
    }
    return true;
  }
}
