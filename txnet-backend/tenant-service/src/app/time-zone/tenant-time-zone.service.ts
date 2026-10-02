import { Injectable, Logger } from '@nestjs/common';
import { TenantType } from '@prisma/client';
import {
  type TenantCapabilityName,
  PLATFORM_DEFAULT_TIMEZONE,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  canonicalTimeZone,
  holdsPermission,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/**
 * A tenant's time zone (TZ-1-d, ADR-0108 point 7): the clock its own reports
 * are answered in, and the zone of every user of it who has none of their
 * own (shared-core `resolveTimeZone`).
 *
 * **Who.** As the operating currency: a reseller's through
 * {@link ResellerAccess} (`staffWrite` to set); the platform's only by its own
 * staff holding `tenant.manage`.
 */

export type TenantTimeZoneView = { timezone: string };

export type TenantTimeZoneRejection = ResellerAccessRejection;

export class TenantTimeZoneRefused extends Error {
  constructor(
    readonly reason: TenantTimeZoneRejection,
    detail = '',
  ) {
    super(`tenant time zone refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantTimeZoneRefused';
  }
}

type Target = { id: string; timezone: string };

@Injectable()
export class TenantTimeZoneService {
  private readonly logger = new Logger(TenantTimeZoneService.name);

  constructor(
    private readonly resellerAccess: ResellerAccess,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async read(actor: ResellerActor, tenantId: string): Promise<TenantTimeZoneView> {
    return { timezone: (await this.admit(actor, tenantId, 'read')).timezone };
  }

  /** `zone` is validated by the schema; it is stored canonical (`Iran` -> `Asia/Tehran`). */
  async set(actor: ResellerActor, tenantId: string, zone: string): Promise<TenantTimeZoneView> {
    const target = await this.admit(actor, tenantId, 'staffWrite');
    const timezone = canonicalTimeZone(zone);
    if (!timezone) throw new RangeError(`not an IANA time zone: ${zone}`);
    if (timezone === target.timezone) return { timezone };
    await this.all.tenant.update({ where: { id: target.id }, data: { timezone } });
    this.logger.log(`time zone of ${target.id} set ${target.timezone} -> ${timezone} by ${actor.userId}`);
    return { timezone };
  }

  private async admit(actor: ResellerActor, tenantId: string, capability: TenantCapabilityName): Promise<Target> {
    const tenant = await this.all.tenant.findUnique({
      where: { id: tenantId },
      select: { tenantType: true, deletedAt: true, timezone: true },
    });
    if (tenant?.tenantType === TenantType.platform_owner && !tenant.deletedAt) {
      if (actor.tenantId !== tenantId || !holdsPermission(actor.permissions, 'tenant.manage')) {
        throw new TenantTimeZoneRefused('not_allowed', tenantId);
      }
      return { id: tenantId, timezone: tenant.timezone };
    }
    try {
      const reseller = await this.resellerAccess.admit(actor, tenantId, capability);
      return { id: reseller.id, timezone: tenant?.timezone ?? PLATFORM_DEFAULT_TIMEZONE };
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new TenantTimeZoneRefused(e.reason, tenantId);
      throw e;
    }
  }
}
