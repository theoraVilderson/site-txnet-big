import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { Reason } from '../profile/predictions';
import { PrismaService } from '../prisma/prisma.service';
import { SUGGESTION_LABEL } from './action-log';
import { OptOuts } from './opt-out';
import { OUTCOME_WINDOW_DAYS } from './outcome';

/**
 * F-038-h (ADR-0109 point 11): the user's own suggestion card in the panel.
 *
 * **Current** = the newest suggestion told to the user (`sent`) in the last
 * {@link OUTCOME_WINDOW_DAYS} days that is still open: nothing bought on it
 * (`convertedAt`, F-038-i), its deadline not passed, of a type the card tells,
 * naming a plan. One card at most — the panel's half of F-1507's one call to
 * action.
 *
 * **Dismiss** closes that card: `sent` → `dismissed`, as the opt-out tap does
 * to the action it came from, but the type stays open — the cooldown (F-1504)
 * already holds it 14 days from the send. **Opt-out** is the tap (F-1505),
 * `OptOuts.optOutFrom`, as the user. Both find the action only as the user's
 * own: another's id is "not found", never acted on.
 */

/** The types the card names a plan for; another type has no card yet. */
export const CARD_TYPES: readonly string[] = ['renew', 'resize_up', 'resize_down'];
const WINDOW_MS = OUTCOME_WINDOW_DAYS * 86_400_000;

export type CardRow = {
  id: string;
  actionType: string;
  status: string;
  sentAt: Date | null;
  deadline: Date | null;
  convertedAt: Date | null;
  reasons: unknown;
};

export type SuggestionCard = {
  actionId: string;
  actionType: string;
  label: typeof SUGGESTION_LABEL;
  grantId: string;
  variantId: string;
  fromVariantId: string | null;
  deadline: string | null;
};

const str = (v: unknown) => (typeof v === 'string' ? v : null);

function cardOf(row: CardRow, now: Date): SuggestionCard | null {
  if (row.status !== 'sent' || !row.sentAt || row.convertedAt) return null;
  if (!CARD_TYPES.includes(row.actionType)) return null;
  if (row.sentAt.getTime() < now.getTime() - WINDOW_MS) return null;
  if (row.deadline && row.deadline.getTime() <= now.getTime()) return null;
  const target = Array.isArray(row.reasons) ? (row.reasons as Reason[]).find((r) => r?.code === 'suggest_variant') : undefined;
  const grantId = str(target?.['grantId']);
  const variantId = str(target?.['variantId']);
  if (!grantId || !variantId) return null;
  return {
    actionId: row.id,
    actionType: row.actionType,
    label: SUGGESTION_LABEL,
    grantId,
    variantId,
    fromVariantId: str(target?.['fromVariantId']),
    deadline: row.deadline ? row.deadline.toISOString() : null,
  };
}

/** The newest open suggestion of these rows, as the card; null when none is. */
export function pickCard(rows: readonly CardRow[], now: Date): SuggestionCard | null {
  const newest = [...rows].sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
  for (const row of newest) {
    const card = cardOf(row, now);
    if (card) return card;
  }
  return null;
}

/** The three answers the controller needs; an interface so its spec fakes it whole. */
export interface MySuggestions {
  current(tenantId: string, userId: string, now: Date): Promise<SuggestionCard | null>;
  /** `null`: no such action of this user's. */
  dismiss(tenantId: string, userId: string, actionId: string, now: Date): Promise<{ dismissed: boolean } | null>;
  /** `null`: no such action of this user's. */
  optOut(tenantId: string, userId: string, actionId: string, now: Date): Promise<{ actionType: string } | null>;
}

@Injectable()
export class MySuggestionService implements MySuggestions {
  constructor(
    private readonly prisma: PrismaService,
    private readonly optOuts: OptOuts,
  ) {}

  async current(tenantId: string, userId: string, now: Date): Promise<SuggestionCard | null> {
    const rows = await this.write(tenantId, (tx) =>
      tx.aiAction.findMany({
        where: {
          tenantId,
          subjectKind: 'user',
          subjectId: userId,
          status: 'sent',
          convertedAt: null,
          sentAt: { gte: new Date(now.getTime() - WINDOW_MS) },
        },
        select: { id: true, actionType: true, status: true, sentAt: true, deadline: true, convertedAt: true, reasons: true },
        orderBy: { sentAt: 'desc' },
        take: 10,
      }),
    );
    return pickCard(rows, now);
  }

  async dismiss(tenantId: string, userId: string, actionId: string, now: Date): Promise<{ dismissed: boolean } | null> {
    return this.write(tenantId, async (tx) => {
      const own = { id: actionId, tenantId, subjectKind: 'user' as const, subjectId: userId };
      const found = await tx.aiAction.findFirst({ where: own, select: { id: true } });
      if (!found) return null;
      const { count } = await tx.aiAction.updateMany({ where: { ...own, status: 'sent' }, data: { status: 'dismissed', outcomeAt: now } });
      return { dismissed: count === 1 };
    });
  }

  optOut(tenantId: string, userId: string, actionId: string, now: Date): Promise<{ actionType: string } | null> {
    return this.optOuts.optOutFrom({ tenantId, kind: 'user', id: userId }, actionId, now);
  }

  private write<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runWithTenant({ id: tenantId }, () => tenantTransaction(this.prisma, fn));
  }
}
