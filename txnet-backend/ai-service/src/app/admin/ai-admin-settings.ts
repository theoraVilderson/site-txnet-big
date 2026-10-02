import { Injectable } from '@nestjs/common';
import { AiActionType, Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { TypeSwitch } from '../decision/type-switch';
import { AI_SETTING_DEFAULTS, AI_V1_ACTION_TYPES } from '../policy/ai-defaults';
import { AiTenantPolicy } from '../policy/ai-tenant-policy';
import { PrismaService } from '../prisma/prisma.service';

/** ADR-0109 point 10: the holdout share a tenant may pick — never 0, or nothing is measured. */
export const HOLDOUT_PERCENT_RANGE = { min: 5, max: 20 } as const;

/**
 * What the AI page may change (F-038-j1). The tenant is the gate's, never the
 * body's: `.strict()` refuses a body that names one. A threshold is a decimal
 * string at two places, as `ai.setting` stores it (F-1503 compares at that
 * precision). Per-type model mode and caps are F-038-w's (user, 2026-10-02).
 */
export const settingsPatchSchema = z
  .object({
    engineEnabled: z.boolean().optional(),
    confidenceThreshold: z
      .string()
      .regex(/^(0(\.\d{1,2})?|1(\.0{1,2})?)$/)
      .optional(),
    holdoutPercent: z.number().int().min(HOLDOUT_PERCENT_RANGE.min).max(HOLDOUT_PERCENT_RANGE.max).optional(),
    disabledActionTypes: z.array(z.nativeEnum(AiActionType)).optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export type SettingsView = {
  engineEnabled: boolean;
  /** Whether the engine runs at all: the package's `ai_recommendation` and a tenant that may sell, besides the switch (F-1550, F-038-x). */
  engineRuns: boolean;
  confidenceThreshold: string;
  holdoutPercent: number;
  disabledActionTypes: AiActionType[];
  /** The types a tenant can switch, in the engine's order (ADR-0109 point 3, v1). */
  actionTypes: AiActionType[];
};

/**
 * The tenant's AI settings for its admin page (F-038-j1). The type list goes
 * through `TypeSwitch` (F-1509), so a type switched off stops what is queued
 * of it. **Switching the engine off stops every suggestion still queued**
 * (`engine_disabled`): the decision run stops at once, and a suggestion
 * decided yesterday must not go out tomorrow under a switch that says off.
 * Lowering the holdout share keeps its recorded members (F-1508).
 */
@Injectable()
export class AiAdminSettings {
  constructor(
    private readonly prisma: PrismaService,
    private readonly types: TypeSwitch,
    private readonly policy: AiTenantPolicy,
  ) {}

  async read(tenantId: string): Promise<SettingsView> {
    const row = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) => tx.aiSetting.findUnique({ where: { tenantId } })),
    );
    const mode = await this.policy.forTenant(tenantId);
    return {
      engineEnabled: row?.engineEnabled ?? AI_SETTING_DEFAULTS.engineEnabled,
      engineRuns: mode.engineRuns,
      confidenceThreshold: (row?.confidenceThreshold ?? new Prisma.Decimal(AI_SETTING_DEFAULTS.confidenceThreshold)).toFixed(2),
      holdoutPercent: row?.holdoutPercent ?? AI_SETTING_DEFAULTS.holdoutPercent,
      disabledActionTypes: row?.disabledActionTypes ?? [],
      actionTypes: [...AI_V1_ACTION_TYPES],
    };
  }

  async write(tenantId: string, userId: string, patch: SettingsPatch): Promise<SettingsView> {
    const { disabledActionTypes, confidenceThreshold, ...rest } = patch;
    const fields = {
      ...rest,
      ...(confidenceThreshold !== undefined ? { confidenceThreshold: new Prisma.Decimal(confidenceThreshold) } : {}),
    };
    if (Object.keys(fields).length > 0) {
      await runWithTenant({ id: tenantId }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          await tx.aiSetting.upsert({
            where: { tenantId },
            create: { tenantId, ...fields, updatedByUserId: userId },
            update: { ...fields, updatedByUserId: userId },
          });
          if (fields.engineEnabled === false) {
            await tx.aiAction.updateMany({
              where: { tenantId, status: { in: ['scheduled', 'awaiting_approval'] } },
              data: { status: 'suppressed', suppressedBy: 'engine_disabled' },
            });
          }
        }),
      );
    }
    if (disabledActionTypes) await this.types.set(tenantId, disabledActionTypes, userId);
    return this.read(tenantId);
  }
}
