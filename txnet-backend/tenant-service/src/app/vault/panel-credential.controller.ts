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
import { PANEL_SECRETS, PanelSecret, ServiceOnlyGuard } from '@txnet-backend/shared-core';

import type { SecretState } from './gateway-credential.service';
import { PanelCredentialRefused, PanelCredentialRejection, PanelCredentialService } from './panel-credential.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SetBody = { tenantId?: unknown; panelId?: unknown; credentials?: unknown; actorId?: unknown; secret?: unknown };
type UseBody = { panelId?: unknown; secret?: unknown };

/** Which secret the call means (F-027-az). Absent is the login, the only one there was before. */
function secretOf(value: unknown): PanelSecret {
  if (value === undefined) return 'login';
  if (typeof value === 'string' && (PANEL_SECRETS as readonly string[]).includes(value)) return value as PanelSecret;
  throw new BadRequestException(`secret must be one of ${PANEL_SECRETS.join(', ')}`);
}

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<PanelCredentialRejection, 400 | 403 | 404> = {
  empty_value: 400,
  not_owner: 403,
  panel_not_found: 404,
  credential_unavailable: 404,
};

/**
 * The seam `billing-service` writes a panel's login through (F-027-ar):
 * `POST /api/internal/vault/panel-credential`. `GatewayCredentialController`'s
 * shape — service-only, no tenant scope, a 404 to anyone else — and it
 * answers `{configured, version, rotatedAt}`, never a value — except `use`,
 * the Opener's read (F-027-aw).
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
    const secret = secretOf(body.secret);
    const actorId = typeof body.actorId === 'string' && UUID.test(body.actorId) ? body.actorId : null;
    try {
      return await this.credentials.set({ tenantId, panelId }, credentials, actorId, secret);
    } catch (e) {
      throw refusal(e);
    }
  }

  /**
   * `POST /api/internal/vault/panel-credential/use` — the login itself, for
   * `network-service`'s Opener (F-027-aw). The only route here that answers a
   * value; the vault it reads is re-derived from the panel row, never named
   * by the caller. `secret: 'radius_secret'` is the allowlist's read of a
   * NAS's shared secret (F-027-az), answered in the same field.
   */
  @Post('use')
  @HttpCode(HttpStatus.OK)
  async use(@Body() body: UseBody): Promise<{ credentials: string }> {
    const panelId = body?.panelId;
    if (typeof panelId !== 'string' || !UUID.test(panelId)) throw new BadRequestException('panelId must be a uuid');
    const secret = secretOf(body.secret);
    try {
      return { credentials: await this.credentials.use(panelId, secret) };
    } catch (e) {
      throw refusal(e);
    }
  }
}

function refusal(e: unknown): unknown {
  if (!(e instanceof PanelCredentialRefused)) return e;
  const payload = { reason: e.reason, message: e.message };
  if (STATUS[e.reason] === 403) return new ForbiddenException(payload);
  if (STATUS[e.reason] === 404) return new NotFoundException(payload);
  return new BadRequestException(payload);
}
