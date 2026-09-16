import { Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import { PaymentProviderName, TenantType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';
import type { NextFunction, Request, Response } from 'express';

import type { MerchantGatewayRef } from '../payment/gateway/gateway-merchant';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/** `/webhook/<provider>/<gatewayId>` at the end of the path, before any query string. */
const WEBHOOK_PATH = /\/webhook\/([a-z_]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

const resolved = new WeakMap<Request, MerchantGatewayRef>();

/** The gateway this middleware resolved for the request. Throws if it did not run: a wiring bug, never a caller's. */
export function webhookGatewayOf(req: Request): MerchantGatewayRef {
  const ref = resolved.get(req);
  if (!ref) throw new Error('WebhookGatewayMiddleware did not run for this request');
  return ref;
}

/**
 * The tenant scope of the **webhook** door (F-104-b, ADR-0051 decision 1).
 *
 * The callback's tenant is its Host (`callback-tenant.middleware.ts`); a
 * provider's server knows no panel host, so here the claim is the gateway id in
 * the path, proven by the gateway row existing with the path's provider. The
 * scope opened is the gateway's **owner** — where its secret lives and what the
 * rate limiter counts under — never the tenant a payment settles in, which only
 * the signed event can name (`deposit-webhook.service.ts`).
 *
 * A middleware and not a guard for the callback's reason: the rate limiter needs
 * the tenant in context. Nest has not parsed `:params` at this point, so the
 * path is read here.
 *
 * **CrossTenantPrismaService:** the read that finds a gateway's owner is what
 * produces the scope, so it cannot run inside one. Unknown id, unknown provider
 * or a mismatch between them is one neutral 404.
 */
@Injectable()
export class WebhookGatewayMiddleware implements NestMiddleware {
  constructor(private readonly prisma: CrossTenantPrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const match = WEBHOOK_PATH.exec((req.originalUrl ?? req.url).split('?')[0]);
    const ref = match ? await this.gatewayOf(match[1], match[2].toLowerCase()) : null;
    if (!ref) throw new NotFoundException();
    resolved.set(req, ref);
    runWithTenant({ id: ref.tenantId }, () => next());
  }

  private async gatewayOf(provider: string, gatewayId: string): Promise<MerchantGatewayRef | null> {
    if (!Object.values(PaymentProviderName).includes(provider as PaymentProviderName)) return null;
    const providerName = provider as PaymentProviderName;

    const own = await this.prisma.tenantGatewayConfig.findUnique({
      where: { id: gatewayId },
      select: { tenantId: true, providerName: true },
    });
    if (own) {
      return own.providerName === providerName ? { tenantId: own.tenantId, source: 'tenant', gatewayId, providerName } : null;
    }

    const platform = await this.prisma.paymentGateway.findUnique({
      where: { id: gatewayId },
      select: { providerName: true },
    });
    if (!platform || platform.providerName !== providerName) return null;
    // A platform gateway's secret is in the platform owner's vault (gateway-merchant.ts).
    const owner = await this.prisma.tenant.findFirst({
      where: { tenantType: TenantType.platform_owner },
      select: { id: true },
    });
    return owner ? { tenantId: owner.id, source: 'platform', gatewayId, providerName } : null;
  }
}
