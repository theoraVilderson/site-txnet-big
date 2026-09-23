import { Injectable } from '@nestjs/common';
import { ConfigStatus } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Is anything still reading the panels this user's service runs on? (F-027-w)
 *
 * The answer is for one sentence on the panel: *metering is unavailable, your
 * service is not cut off.* Without it, a user whose collector has stopped sees
 * a usage figure that stopped moving and reads it as a broken service — and
 * files the ticket for an outage that is not one. The collector raised their
 * ceilings to what their wallet backs on its way out (ADR-0078), so the
 * service is fine; what is missing is a measurement, and this says so.
 *
 * It is read off `panel.lastSuccessfulCollectionAt`, the same mark the
 * external watchdog reads, and judged at the same threshold — so the panel and
 * the operators' alert are one answer to one question rather than two.
 */

/** C-09: the wire values, declared once. The panel's copy (F-027-ac) is keyed on them. */
export const METERING_STATES = ['healthy', 'unavailable', 'not_metered'] as const;
export type MeteringState = (typeof METERING_STATES)[number];

/**
 * Five missed bulk passes (`collect.DefaultInterval` is 60s). It is the
 * threshold `NetworkCollectionStalled` warns at in `network.rules.yml`; move
 * one and the other has to move with it.
 */
export const STALE_AFTER_SECONDS = 300;

export type CollectionHealth = {
  metering: MeteringState;
  /** The stalest panel's last completed pass; null where one was never collected, or there is no config. */
  lastCollectedAt: Date | null;
  /** Seconds since then; null with it. */
  staleForSeconds: number | null;
  /** How many of the user's configs sit on a panel past the threshold. */
  configsAffected: number;
};

/** One config that carries traffic, and the mark on the panel it sits on. */
export type ConfigCollection = { panelId: string; lastSuccessfulCollectionAt: Date | null };

/**
 * Judges a user's configs against the threshold.
 *
 * The user is as metered as the worst panel they are on: the one that stopped
 * is the one they will notice. A panel never collected at all is the most
 * unavailable a panel can be, never the least — nothing has been measured
 * there — so it is stale and has no age to report.
 */
export function judgeCollection(configs: ConfigCollection[], now: Date): CollectionHealth {
  if (configs.length === 0) return { metering: 'not_metered', lastCollectedAt: null, staleForSeconds: null, configsAffected: 0 };

  const ageOf = (at: Date | null) => (at === null ? null : Math.floor((now.getTime() - at.getTime()) / 1000));
  const isStale = (at: Date | null) => {
    const age = ageOf(at);
    return age === null || age > STALE_AFTER_SECONDS;
  };

  const never = configs.some((config) => config.lastSuccessfulCollectionAt === null);
  const stalest = never
    ? null
    : configs.reduce<Date>(
        (oldest, config) => (config.lastSuccessfulCollectionAt as Date) < oldest ? (config.lastSuccessfulCollectionAt as Date) : oldest,
        configs[0].lastSuccessfulCollectionAt as Date,
      );
  const configsAffected = configs.filter((config) => isStale(config.lastSuccessfulCollectionAt)).length;

  return {
    metering: configsAffected > 0 ? 'unavailable' : 'healthy',
    lastCollectedAt: stalest,
    staleForSeconds: ageOf(stalest),
    configsAffected,
  };
}

@Injectable()
export class CollectionHealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The flag for one user. Only configs that can carry traffic count — a
   * disabled config on a stalled panel is not a service anybody is using, and
   * counting it would tell a user their service is unmetered when it is off.
   *
   * RLS scopes the read (`network.config` is strict, `network.panel` shared
   * read), so a config and the panel it sits on are both the caller tenant's
   * or the platform's, and nothing here chooses a tenant.
   */
  forUser(userId: string, now: Date = new Date()): Promise<CollectionHealth> {
    TenantContext.current('collection health');
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.config.findMany({
        where: { userId, status: ConfigStatus.active, desiredEnabled: true },
        select: { panelId: true, panel: { select: { lastSuccessfulCollectionAt: true } } },
      });
      return judgeCollection(
        rows.map((row) => ({ panelId: row.panelId, lastSuccessfulCollectionAt: row.panel.lastSuccessfulCollectionAt })),
        now,
      );
    });
  }
}
