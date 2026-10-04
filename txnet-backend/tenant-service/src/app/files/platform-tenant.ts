import { Injectable } from '@nestjs/common';
import { TenantType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The platform owner's tenant id, read once (`tenant` has no RLS). Its guides'
 * files live under its prefix and are every Host's (ADR-0117 point 2); the
 * guide writer stores the platform's uploads there.
 */
@Injectable()
export class PlatformTenant {
  private pending: Promise<string> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  id(): Promise<string> {
    this.pending ??= this.prisma.tenant
      .findFirst({ where: { tenantType: TenantType.platform_owner, deletedAt: null }, select: { id: true } })
      .then((row) => {
        if (!row) throw new Error('no platform_owner tenant');
        return row.id;
      })
      .catch((err: Error) => {
        // Not cached: the next request asks again.
        this.pending = null;
        throw err;
      });
    return this.pending;
  }
}
