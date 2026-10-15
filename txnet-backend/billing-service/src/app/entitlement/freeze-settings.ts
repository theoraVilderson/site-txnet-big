import { Prisma } from '@prisma/client';

/** A tenant's freeze switches (F-0401-b). */
export type FreezeSettings = { selfFreezeEnabled: boolean; selfFreezeStopsClock: boolean };

/**
 * The platform's answer for a tenant that set nothing (catalog F-0401): a user
 * may freeze their own metered Grant, and the clock runs while it is frozen —
 * a metered Grant frozen costs the seller nothing, a stopped clock would.
 */
export const SELF_FREEZE_DEFAULTS: Readonly<FreezeSettings> = Object.freeze({ selfFreezeEnabled: true, selfFreezeStopsClock: false });

/** The switches in effect for the tenant in scope (`grant_freeze_setting`, else the defaults). */
export async function freezeSettingsOf(tx: Prisma.TransactionClient, tenantId: string): Promise<FreezeSettings> {
  const row = await tx.grantFreezeSetting.findUnique({ where: { tenantId }, select: { selfFreezeEnabled: true, selfFreezeStopsClock: true } });
  return row ?? { ...SELF_FREEZE_DEFAULTS };
}
