import { Prisma } from '@prisma/client';
import type { UsageUnattributedRow } from '@txnet-backend/shared-core';

import type { PrismaService } from '../prisma/prisma.service';

/** The one table this module writes. */
type UnattributedStore = Pick<PrismaService, 'unattributedUsage'>;

/** How many times a running total is recomputed when other passes move its row's cursor first. */
const TOTAL_WRITE_ATTEMPTS = 3;

/** An up/down byte pair. */
interface ByteFigure {
  up: bigint;
  down: bigint;
}

/**
 * The rise of a running total above the last one — network-service's
 * `Normaliser.rise`, so both sides read a counter alike: a total that fell on
 * either side is a reset, and the whole figure is new.
 */
function riseAbove(last: ByteFigure, reading: ByteFigure): ByteFigure {
  if (reading.up >= last.up && reading.down >= last.down) {
    return { up: reading.up - last.up, down: reading.down - last.down };
  }
  return reading;
}

/**
 * Usage against a remote client no config claims (invariant 24: one row per
 * `(panel, remote identifier)`).
 *
 * Deduplicated on `lastSeenAt` rather than on an id, because these rows have
 * none: only bytes observed *after* what the row already counted apply, so a
 * redelivered pass — which carries the same `observedAt` — adds nothing.
 * Without that a retried message inflates the one number the unattributed
 * report exists to show.
 */
export async function writeDownUnattributed(
  prisma: UnattributedStore,
  panelId: string,
  remoteIdentifier: string,
  row: Pick<
    UsageUnattributedRow,
    'upBytes' | 'downBytes' | 'observedAt' | 'cumulative'
  >,
): Promise<boolean> {
  const reading: ByteFigure = {
    up: BigInt(row.upBytes),
    down: BigInt(row.downBytes),
  };
  const observedAt = new Date(row.observedAt);
  if (row.cumulative)
    return writeDownTotal(
      prisma,
      panelId,
      remoteIdentifier,
      reading,
      observedAt,
    );
  const { count } = await prisma.unattributedUsage.updateMany({
    where: { panelId, remoteIdentifier, lastSeenAt: { lt: observedAt } },
    data: {
      upBytes: { increment: reading.up },
      downBytes: { increment: reading.down },
      observationCount: { increment: 1 },
      lastSeenAt: observedAt,
    },
  });
  if (count > 0) return true;
  // A false create is a row at or past this observation: already counted.
  return createUnattributed(
    prisma,
    panelId,
    remoteIdentifier,
    reading,
    null,
    observedAt,
  );
}

/**
 * A running total adds its rise above the row's cursor (LIVE-1-z). The
 * update is guarded by the `lastSeenAt` it was computed from, so a pass that
 * moved the cursor in between sends this one round again rather than
 * counting the same bytes twice.
 */
async function writeDownTotal(
  prisma: UnattributedStore,
  panelId: string,
  remoteIdentifier: string,
  reading: ByteFigure,
  observedAt: Date,
): Promise<boolean> {
  for (let attempt = 0; attempt < TOTAL_WRITE_ATTEMPTS; attempt += 1) {
    const row = await prisma.unattributedUsage.findUnique({
      where: { panelId_remoteIdentifier: { panelId, remoteIdentifier } },
      select: { lastUpBytes: true, lastDownBytes: true, lastSeenAt: true },
    });
    if (!row) {
      if (
        await createUnattributed(
          prisma,
          panelId,
          remoteIdentifier,
          reading,
          reading,
          observedAt,
        )
      )
        return true;
      continue;
    }
    if (row.lastSeenAt >= observedAt) return false;
    const rise = riseAbove(
      { up: row.lastUpBytes, down: row.lastDownBytes },
      reading,
    );
    const { count } = await prisma.unattributedUsage.updateMany({
      where: { panelId, remoteIdentifier, lastSeenAt: row.lastSeenAt },
      data: {
        upBytes: { increment: rise.up },
        downBytes: { increment: rise.down },
        lastUpBytes: reading.up,
        lastDownBytes: reading.down,
        observationCount: { increment: 1 },
        lastSeenAt: observedAt,
      },
    });
    if (count > 0) return true;
  }
  // Other passes kept moving the cursor. A total loses nothing by waiting:
  // the next pass's total carries this one's bytes.
  return false;
}

/** The row's first observation; false when another pass created it first (P2002). */
async function createUnattributed(
  prisma: UnattributedStore,
  panelId: string,
  remoteIdentifier: string,
  reading: ByteFigure,
  cursor: ByteFigure | null,
  observedAt: Date,
): Promise<boolean> {
  try {
    await prisma.unattributedUsage.create({
      data: {
        panelId,
        remoteIdentifier,
        upBytes: reading.up,
        downBytes: reading.down,
        ...(cursor && { lastUpBytes: cursor.up, lastDownBytes: cursor.down }),
        lastSeenAt: observedAt,
      },
    });
    return true;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    )
      return false;
    throw err;
  }
}
