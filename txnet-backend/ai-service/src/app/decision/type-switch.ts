import { Injectable } from '@nestjs/common';
import type { AiActionType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * F-1509: a reseller can switch any action type off completely — it is their
 * brand. `set` replaces `ai.setting.disabledActionTypes` (any type, the
 * "later" ones included) and, in the same transaction, stops whatever of
 * those types is already queued, so nothing switched off still goes out.
 * `resolveAiMode` stops the next candidates; `ActionLog.record` the ones in
 * flight.
 */
@Injectable()
export class TypeSwitch {
  constructor(private readonly prisma: PrismaService) {}

  async set(tenantId: string, disabledActionTypes: AiActionType[], updatedByUserId: string): Promise<void> {
    const types = [...new Set(disabledActionTypes)];
    await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        await tx.aiSetting.upsert({
          where: { tenantId },
          create: { tenantId, disabledActionTypes: types, updatedByUserId },
          update: { disabledActionTypes: types, updatedByUserId },
        });
        if (types.length === 0) return;
        await tx.aiAction.updateMany({
          where: { tenantId, actionType: { in: types }, status: { in: ['scheduled', 'awaiting_approval'] } },
          data: { status: 'suppressed', suppressedBy: 'type_disabled' },
        });
      }),
    );
  }
}
