import { Injectable } from '@nestjs/common';
import {
  runWithTenant,
  TenantEntitlements,
  tenantTransaction,
  type TenantEntitlementReader,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { resolveAiMode, type AiTenantMode } from './ai-defaults';

/**
 * A tenant's AI mode, read in one transaction under its own tenant (F-1550):
 * the `ai_recommendation` key (TenantEntitlements — `tenant.tenant` has no RLS,
 * `tenant_feature_entitlement` is read under the bound tenant), its
 * `ai.setting` row if any, and whether it has an active provider.
 */
@Injectable()
export class AiTenantPolicy {
  constructor(private readonly prisma: PrismaService) {}

  forTenant(tenantId: string): Promise<AiTenantMode> {
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const entitled = await new TenantEntitlements(tx as unknown as TenantEntitlementReader).allows(
          tenantId,
          'ai_recommendation',
        );
        if (!entitled) return resolveAiMode({ entitled, setting: null, hasActiveProvider: false });
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
        });
      }),
    );
  }
}
