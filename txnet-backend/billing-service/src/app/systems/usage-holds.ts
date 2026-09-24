import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UsageDispositionState } from '@prisma/client';
import { OutboxEventType, USAGE_RELEASE_AGGREGATE, type UsageReleasePayload } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

export type HoldQueueQuery = { state?: 'pending' | 'all'; after?: string; limit?: number };

const HOLD_PAGE = 50;

const HOLD_FIELDS = {
  id: true,
  configId: true,
  panelId: true,
  upBytes: true,
  downBytes: true,
  reason: true,
  state: true,
  heldFrom: true,
  heldAt: true,
  resolvedAt: true,
  resolvedByAdminId: true,
  resolutionNote: true,
} satisfies Prisma.UsageHoldSelect;

type HoldRow = Prisma.UsageHoldGetPayload<{ select: typeof HOLD_FIELDS }>;

/**
 * The holds queue (F-027-at, ADR-0080 decision 3): bytes we believe and could
 * not bill (ADR-0074), and the two ways a person ends one.
 *
 * **Release goes through the meter.** This service never bills and never
 * flips a hold to `released`: it queues an outbox event, and
 * `metering-service` flips the hold and bills it in one transaction through
 * the path a collected delta takes. A second click queues a second event with
 * the same derived delta id, which the meter absorbs.
 *
 * **A write-off is never charged** and happens here, once: conditional on
 * `pending`, recording who and why. A release already queued for it then
 * finds it resolved and bills nothing.
 *
 * `network.usage_hold` has no RLS policy and no relation to `panel`, so the
 * scope is applied as the set of panel ids {@link panelScopeOf} admits.
 */
@Injectable()
export class UsageHoldsService {
  private readonly logger = new Logger(UsageHoldsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Holds on panels in scope, newest first, keyset-paged by id. `state: pending` narrows to the open ones. */
  async holds(actor: SystemsActor, query: HoldQueueQuery) {
    const names = await this.panelsInScope(actor);
    const take = query.limit ?? HOLD_PAGE;

    const rows = await this.prisma.usageHold.findMany({
      where: {
        panelId: { in: [...names.keys()] },
        ...(query.state === 'pending' ? { state: UsageDispositionState.pending } : {}),
      },
      select: HOLD_FIELDS,
      orderBy: [{ heldAt: 'desc' }, { id: 'desc' }],
      take,
      ...(query.after ? { cursor: { id: query.after }, skip: 1 } : {}),
    });

    return {
      items: rows.map((h) => ({ ...wire(h), panelName: names.get(h.panelId) ?? null })),
      next: rows.length === take ? rows[rows.length - 1].id : null,
    };
  }

  /** Queue a release for the meter. The hold stays `pending` until the meter bills it. */
  async release(actor: SystemsActor, holdId: string, input: { note?: string }) {
    const hold = await this.pendingInScope(actor, holdId);

    const payload: UsageReleasePayload = { holdId: hold.id, adminId: actor.adminId, note: input.note ?? null };
    await this.prisma.outboxEvent.create({
      data: {
        aggregate: USAGE_RELEASE_AGGREGATE,
        aggregateId: hold.id,
        type: OutboxEventType.USAGE_RELEASE,
        payload,
      },
    });

    this.logger.log(`hold ${hold.id} release queued by ${actor.adminId}`);
    return { id: hold.id, state: UsageDispositionState.pending, release: 'queued' as const };
  }

  /** Write a hold off: never charged, once, with who and why on the row. */
  async writeOff(actor: SystemsActor, holdId: string, input: { note: string }) {
    const names = await this.panelsInScope(actor);
    const where = { id: holdId, panelId: { in: [...names.keys()] } };

    const { count } = await this.prisma.usageHold.updateMany({
      where: { ...where, state: UsageDispositionState.pending },
      data: {
        state: UsageDispositionState.written_off,
        resolvedAt: new Date(),
        resolvedByAdminId: actor.adminId,
        resolutionNote: input.note,
      },
    });

    const hold = await this.prisma.usageHold.findFirst({ where, select: HOLD_FIELDS });
    if (!hold) throw new SystemsRefused('not_found');
    if (count === 0) throw new SystemsRefused('already_resolved');

    this.logger.log(`hold ${hold.id} written off by ${actor.adminId}`);
    return { ...wire(hold), panelName: names.get(hold.panelId) ?? null };
  }

  private async panelsInScope(actor: SystemsActor) {
    const scope = await panelScopeOf(this.prisma, actor);
    const panels = await this.prisma.panel.findMany({ where: scope, select: { id: true, name: true } });
    return new Map(panels.map((p) => [p.id, p.name]));
  }

  private async pendingInScope(actor: SystemsActor, holdId: string) {
    const names = await this.panelsInScope(actor);
    const hold = await this.prisma.usageHold.findFirst({
      where: { id: holdId, panelId: { in: [...names.keys()] } },
      select: { id: true, state: true },
    });
    if (!hold) throw new SystemsRefused('not_found');
    if (hold.state !== UsageDispositionState.pending) throw new SystemsRefused('already_resolved');
    return hold;
  }
}

/** Bytes as decimal strings: a BIGINT does not survive `JSON.stringify`, nor a double past 2^53. */
function wire(h: HoldRow) {
  return { ...h, upBytes: h.upBytes.toString(), downBytes: h.downBytes.toString() };
}
