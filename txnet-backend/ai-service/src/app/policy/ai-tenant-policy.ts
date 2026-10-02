import { Inject, Injectable } from '@nestjs/common';
import {
  runWithTenant,
  TENANT_STATUS_STORE,
  TenantEntitlements,
  type TenantStatusStore,
  tenantTransaction,
  type TenantEntitlementReader,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { resolveAiMode, type AiTenantMode } from './ai-defaults';
import { tenantMaySell } from './tenant-sells';

/**
 * A tenant's AI mode, read in one transaction under its own tenant (F-1550):
 * the `ai_recommendation` key (TenantEntitlements — `tenant.tenant` has no RLS,
 * `tenant_feature_entitlement` is read under the bound tenant), its
 * `ai.setting` row if any, and whether it has an active provider. First,
 * whether it may sell at all (F-038-x) — one Redis read, and no transaction
 * for a tenant that may not.
 */
@Injectable()
export class AiTenantPolicy {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TENANT_STATUS_STORE) private readonly status: TenantStatusStore,
  ) {}

  async forTenant(tenantId: string): Promise<AiTenantMode> {
    if (!(await tenantMaySell(this.status, tenantId))) {
      return resolveAiMode({ entitled: false, setting: null, hasActiveProvider: false, sells: false });
    }
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const entitled = await new TenantEntitlements(tx as unknown as TenantEntitlementReader).allows(
          tenantId,
          'ai_recommendation',
        );
        if (!entitled) return resolveAiMode({ entitled, setting: null, hasActiveProvider: false, sells: true });
        // One after the other: an interactive transaction is one connection.
        const setting = await tx.aiSetting.findUnique({ where: { tenantId } });
        const providers = await tx.aiProvider.count({ where: { tenantId, isActive: true } });
        return resolveAiMode({
          entitled,
          setting: setting && {
            engineEnabled: setting.engineEnabled,
            disabledActionTypes: setting.disabledActionTypes,
            automaticActionTypes: setting.automaticActionTypes,
            confidenceThreshold: setting.confidenceThreshold.toNumber(),
            holdoutPercent: setting.holdoutPercent,
          },
          hasActiveProvider: providers > 0,
          sells: true,
        });
      }),
    );
  }
}
