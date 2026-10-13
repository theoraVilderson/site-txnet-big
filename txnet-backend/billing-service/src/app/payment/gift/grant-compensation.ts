import { Prisma } from '@prisma/client';

/** One kind per act: whole days onto the Grant's end, or bytes onto its bag. */
export type CompensationAsk = { days: number } | { bytes: bigint };
export type CompensationCap = { days: number; bytes: bigint };

const GIB = BigInt(1024 ** 3);

/** What applies to a tenant that set none (KS-1-c): enough for an outage's apology, small enough to be no one's loss. */
export const PLATFORM_COMPENSATION_CAP: CompensationCap = { days: 3, bytes: BigInt(5) * GIB };
/** The cap counts what one Grant was given over this many days, rolling. */
export const COMPENSATION_WINDOW_DAYS = 30;
/** The highest cap a tenant may set: a bound that catches a typo, not a policy. */
export const MAX_COMPENSATION_CAP: CompensationCap = { days: 365, bytes: BigInt(10_000) * GIB };

const DAY_MS = 86_400_000;

/** Bytes travel as strings: a JSON number loses them past 2^53. */
type Figures = { days: number; bytes: string };
const figures = (c: CompensationCap): Figures => ({ days: c.days, bytes: c.bytes.toString() });

/**
 * The ask would take this Grant past its cap in the window: the figures say
 * how far it may still go. Flat, as the error envelope carries only scalars.
 */
export class CompensationOverCap extends Error {
  readonly reason = 'compensation_over_cap';
  constructor(readonly facts: { windowDays: number; capDays: number; capBytes: string; usedDays: number; usedBytes: string }) {
    super(`compensation over cap: used ${facts.usedDays}d ${facts.usedBytes}B of ${facts.capDays}d ${facts.capBytes}B`);
    this.name = 'CompensationOverCap';
  }
}

export type CompensationCapView = {
  /** The tenant's own cap, or `null` when the platform's applies. */
  own: Figures | null;
  platform: Figures;
  effective: Figures;
  windowDays: number;
};

async function capOf(tx: Prisma.TransactionClient, tenantId: string): Promise<{ own: CompensationCap | null; effective: CompensationCap }> {
  const row = await tx.grantCompensationCap.findUnique({ where: { tenantId }, select: { days: true, bytes: true } });
  const own = row ? { days: row.days, bytes: row.bytes } : null;
  return { own, effective: own ?? PLATFORM_COMPENSATION_CAP };
}

/** The tenant's cap as the panel shows it; `tx` is in the tenant's scope. */
export async function compensationCapView(tx: Prisma.TransactionClient, tenantId: string): Promise<CompensationCapView> {
  const { own, effective } = await capOf(tx, tenantId);
  return { own: own && figures(own), platform: figures(PLATFORM_COMPENSATION_CAP), effective: figures(effective), windowDays: COMPENSATION_WINDOW_DAYS };
}

/**
 * Admit one compensation on `grantId` against its tenant's cap and write it
 * down (KS-1-c, ADR-0140 (2)). The Grant is locked first, so two acts at once
 * are counted one after the other and cannot both fit under one cap. The sum
 * is over this Grant's ledger rows in the last 30 days, each kind against its
 * own cap. Over it is {@link CompensationOverCap}, before anything is written.
 * The caller performs the act in the same transaction: a refused act rolls
 * the ledger row back with it.
 */
export async function claimCompensation(
  tx: Prisma.TransactionClient,
  grantId: string,
  ask: CompensationAsk,
  by: { tenantId: string; actorUserId: string; reason: string; at: Date },
): Promise<{ id: string }> {
  await tx.$queryRaw`SELECT id FROM "entitlement"."grant" WHERE "id" = ${grantId}::uuid FOR UPDATE`;
  const { effective } = await capOf(tx, by.tenantId);
  const since = new Date(by.at.getTime() - COMPENSATION_WINDOW_DAYS * DAY_MS);
  const sum = await tx.grantCompensation.aggregate({ where: { grantId, createdAt: { gte: since } }, _sum: { days: true, bytes: true } });
  const used: CompensationCap = { days: sum._sum.days ?? 0, bytes: sum._sum.bytes ?? BigInt(0) };
  const days = 'days' in ask ? ask.days : 0;
  const bytes = 'bytes' in ask ? ask.bytes : BigInt(0);
  // Only the kind asked: a lowered traffic cap already passed does not close days.
  const over = 'days' in ask ? used.days + days > effective.days : used.bytes + bytes > effective.bytes;
  if (over) {
    throw new CompensationOverCap({
      windowDays: COMPENSATION_WINDOW_DAYS,
      capDays: effective.days,
      capBytes: effective.bytes.toString(),
      usedDays: used.days,
      usedBytes: used.bytes.toString(),
    });
  }
  return tx.grantCompensation.create({
    data: { tenantId: by.tenantId, grantId, actorUserId: by.actorUserId, reason: by.reason, days, bytes, createdAt: by.at },
    select: { id: true },
  });
}
