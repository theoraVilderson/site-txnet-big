import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SessionStore } from '../auth/session/session.store';

/** What an impersonation rode on: the consents (tier B) or the emergency entry (tier C) that just ended. */
export type ImpersonationGround = { consentIds?: string[]; entryId?: string };

/**
 * Ends every running impersonation that rode on a consent or an emergency entry
 * the moment that ground goes (F-117-e, ADR-0104): a revoke, a superseding
 * grant, an entry ended early. Expiry needs no call — the session was minted to
 * end no later than its ground. Rows first (the record), then the Redis markers
 * `auth-handler` reads, so the very next request is refused.
 *
 * `impersonation_session` and `session` carry no tenant RLS: the app pool reads
 * them from any scope.
 */
@Injectable()
export class ImpersonationLeash {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionStore,
  ) {}

  async endUnder(ground: ImpersonationGround, now = new Date()): Promise<number> {
    const or = [
      ...(ground.consentIds?.length ? [{ consentId: { in: ground.consentIds } }] : []),
      ...(ground.entryId ? [{ emergencyEntryId: ground.entryId }] : []),
    ];
    if (!or.length) return 0;
    const db = this.prisma as unknown as Pick<PrismaClient, 'impersonationSession' | 'session'>;
    const running = await db.impersonationSession.findMany({ where: { endedAt: null, OR: or }, select: { id: true } });
    if (!running.length) return 0;
    const ids = running.map((r) => r.id);
    const live = await db.session.findMany({
      where: { impersonationSessionId: { in: ids }, revokedAt: null },
      select: { id: true, userId: true },
    });
    await db.impersonationSession.updateMany({ where: { id: { in: ids } }, data: { endedAt: now } });
    await db.session.updateMany({
      where: { impersonationSessionId: { in: ids }, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'impersonation_ended' },
    });
    for (const s of live) await this.sessions.drop(s.id, s.userId);
    return running.length;
  }
}
