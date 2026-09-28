import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { GrantNoticeLevel } from './grant-notice-level.schema';

/**
 * A user's notice level per Grant (F-601-o): a buyer of five services for
 * friends sets theirs to `essential`, and the ledger's claim mutes every
 * notice of those Grants but a cutoff. Beside the kinds muted on every Grant
 * (F-601-m), never instead of them.
 *
 * **Keyed by the user who set it** (invariant 15): read and written under the
 * gate's `userId`, and the claim reads `(userId, grantId)` — so a Grant id
 * that is not the caller's names a row nothing reads, and no ownership read
 * of billing is needed. `all` is no row.
 *
 * The app pool: no `tenantId`, no RLS, like `notification_preference`.
 */
@Injectable()
export class GrantNoticeLevelService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's Grants set to essential; every other Grant of theirs is `all`. */
  async list(userId: string): Promise<{ essential: string[] }> {
    const rows = await this.prisma.notificationGrantPreference.findMany({
      where: { userId, level: 'essential' },
      select: { grantId: true },
      orderBy: { grantId: 'asc' },
    });
    return { essential: rows.map((r) => r.grantId) };
  }

  async level(userId: string, grantId: string): Promise<GrantNoticeLevel> {
    const row = await this.prisma.notificationGrantPreference.findUnique({
      where: { userId_grantId: { userId, grantId } },
      select: { level: true },
    });
    return row?.level === 'essential' ? 'essential' : 'all';
  }

  async set(userId: string, grantId: string, level: GrantNoticeLevel): Promise<{ grantId: string; level: GrantNoticeLevel }> {
    if (level === 'all') {
      await this.prisma.notificationGrantPreference.deleteMany({ where: { userId, grantId } });
    } else {
      await this.prisma.notificationGrantPreference.upsert({
        where: { userId_grantId: { userId, grantId } },
        create: { userId, grantId, level },
        update: { level },
      });
    }
    return { grantId, level };
  }
}
