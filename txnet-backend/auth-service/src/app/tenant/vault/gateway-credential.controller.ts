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

import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { TenantAgnostic } from '../tenant-agnostic.decorator';
import {
  GatewayCredentialRefused,
  GatewayCredentialRejection,
  GatewayCredentialService,
  GatewayCredentialState,
  GatewayCredentialTarget,
} from './gateway-credential.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TargetBody = { tenantId?: unknown; source?: unknown; gatewayId?: unknown };
type SetBody = TargetBody & { merchantId?: unknown; secretKey?: unknown; actorId?: unknown };

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<GatewayCredentialRejection, 400 | 403 | 404> = {
  empty_value: 400,
  nothing_to_set: 400,
  not_owner: 403,
  gateway_not_found: 404,
};

/**
 * The seam `billing-service` writes a payment gateway's secrets through
 * (F-102-a, D-31): `/api/internal/vault/gateway-credential*`.
 *
 * A third internal route family on the vault, and the first that **writes a
 * value**. What it hands back is still no value: `{merchantId, secretKey}` each
 * as `{configured, version, rotatedAt}`. `billing` needs to know a gateway can
 * take a payment, never what it is charged with — that is read at payment time
 * through `GatewayMerchant`, audited per use.
 *
 * `@TenantAgnostic` and `ServiceOnlyGuard`, like `VaultInternalController`: the
 * caller is a process, the tenant is a field it names, and
 * `GatewayCredentialService` re-derives whether that tenant really owns the
 * gateway before anything is stored. An unrecognised caller gets a 404 that is
 * indistinguishable from a route that does not exist.
 *
 * `POST` for all three, including the state read, because a gateway id and a
 * tenant id in a query string end up in access logs, and this family is kept
 * out of them.
 */
@Controller('internal/vault/gateway-credential')
@UseGuards(ServiceOnlyGuard)
@TenantAgnostic()
export class GatewayCredentialController {
  constructor(private readonly credentials: GatewayCredentialService) {}

  /** Store or rotate the secrets sent. An absent field is left as it is. */
  @Post()
  @HttpCode(HttpStatus.OK)
  async set(@Body() body: SetBody): Promise<GatewayCredentialState> {
    const target = this.target(body);
    const secret = (v: unknown, name: string) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string' || v.length > 512) throw new BadRequestException(`${name} must be a string of at most 512 characters`);
      return v;
    };
    const actorId = typeof body.actorId === 'string' && UUID.test(body.actorId) ? body.actorId : null;
    return this.refusing(() =>
      this.credentials.set(
        target,
        { merchantId: secret(body.merchantId, 'merchantId'), secretKey: secret(body.secretKey, 'secretKey') },
        actorId,
      ),
    );
  }

  /** Whether each secret is configured. */
  @Post('state')
  @HttpCode(HttpStatus.OK)
  async state(@Body() body: TargetBody): Promise<GatewayCredentialState> {
    const target = this.target(body);
    return this.refusing(() => this.credentials.state(target));
  }

  /** Revoke both — the gateway is being deactivated or deleted. */
  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Body() body: TargetBody): Promise<GatewayCredentialState> {
    const target = this.target(body);
    return this.refusing(() => this.credentials.revoke(target));
  }

  private target(body: TargetBody): GatewayCredentialTarget {
    const { tenantId, source, gatewayId } = body ?? {};
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new BadRequestException('tenantId must be a uuid');
    if (typeof gatewayId !== 'string' || !UUID.test(gatewayId)) throw new BadRequestException('gatewayId must be a uuid');
    if (source !== 'tenant' && source !== 'platform') throw new BadRequestException("source must be 'tenant' or 'platform'");
    return { tenantId, source, gatewayId };
  }

  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof GatewayCredentialRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      if (STATUS[e.reason] === 403) throw new ForbiddenException(payload);
      if (STATUS[e.reason] === 404) throw new NotFoundException(payload);
      throw new BadRequestException(payload);
    }
  }
}
