import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ServiceOnlyGuard } from '@txnet-backend/shared-core';

import type { SecretState } from './gateway-credential.service';
import { PanelCredentialRefused, PanelCredentialRejection, PanelCredentialService } from './panel-credential.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SetBody = { tenantId?: unknown; panelId?: unknown; credentials?: unknown; actorId?: unknown };

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<PanelCredentialRejection, 400 | 403 | 404> = {
  empty_value: 400,
  not_owner: 403,
  panel_not_found: 404,
};

/**
 * The seam `billing-service` writes a panel's login through (F-027-ar):
 * `POST /api/internal/vault/panel-credential`. `GatewayCredentialController`'s
 * shape — service-only, no tenant scope, a 404 to anyone else — and it
 * answers `{configured, version, rotatedAt}`, never a value.
 */
@Controller('internal/vault/panel-credential')
@UseGuards(ServiceOnlyGuard)
export class PanelCredentialController {
  constructor(private readonly credentials: PanelCredentialService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async set(@Body() body: SetBody): Promise<SecretState> {
    const { tenantId, panelId, credentials } = body ?? {};
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new BadRequestException('tenantId must be a uuid');
    if (typeof panelId !== 'string' || !UUID.test(panelId)) throw new BadRequestException('panelId must be a uuid');
    if (typeof credentials !== 'string' || credentials.length > 4096) {
      throw new BadRequestException('credentials must be a string of at most 4096 characters');
    }
    const actorId = typeof body.actorId === 'string' && UUID.test(body.actorId) ? body.actorId : null;
    try {
      return await this.credentials.set({ tenantId, panelId }, credentials, actorId);
    } catch (e) {
      if (!(e instanceof PanelCredentialRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      if (STATUS[e.reason] === 403) throw new ForbiddenException(payload);
      if (STATUS[e.reason] === 404) throw new NotFoundException(payload);
      throw new BadRequestException(payload);
    }
  }
}
