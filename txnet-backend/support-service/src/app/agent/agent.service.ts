import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationStatus, MessageSenderKind, Prisma } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import {
  AttachmentView,
  ConversationRefused,
  ConversationRow,
  ConversationSummary,
  MessageRow,
  MessageView,
  PAGE_DEFAULT,
  PAGE_MAX,
  SupportCaller,
  UNFINISHED,
  attachmentViewOf,
  moveCursor,
  summaryOf,
  unreadCounts,
  viewOf,
  writingMessage,
} from '../conversations/conversations.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelProof, SupportRealtime, TYPING_TTL_MS } from '../realtime/support-realtime';
import { SUPPORT_AGENT_PERMISSION } from './support-agent.guard';

/**
 * The agent's side of support (F-033-d, catalog §11.3): the unified inbox,
 * assign, reply, internal notes, resolve and close.
 *
 * The caller holds `support.agent` (`SupportAgentGuard`); the boundary is the
 * tenant, held by Row-Level Security in every `tenantTransaction` — an agent
 * reaches every conversation of its tenant and none of another's (§11.6). A
 * reseller is its own tenant, so that is its subtree until reseller nodes
 * exist (`resellerPath`, F-901).
 *
 * A reply and a note share the user's `seq` counter (invariant 3). A note
 * changes nothing the user can see — not the status, not `lastMessageAt`, not
 * the channel (invariant 5).
 */

/** What an agent may see of an account: the agent side names people, the user side never does. */
export interface AgentConversationView extends ConversationSummary {
  userId: string;
  assignedToUserId: string | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

export interface AgentMessageView extends MessageView {
  internal: boolean;
  senderUserId: string | null;
}

export interface AgentMessagePage {
  conversation: AgentConversationView;
  messages: AgentMessageView[];
  hasEarlier: boolean;
  /** The calling agent's cursor. */
  lastReadSeq: number;
  /** How far the conversation's user has read — "seen". */
  seenUpToSeq: number;
  realtime: ChannelProof | null;
}

/** catalog §11.3's filters. Every view but `pending` is the unfinished threads. */
export const INBOX_VIEWS = ['pending', 'live', 'mine', 'unassigned'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

/** Waiting on an agent: never answered, or the user wrote last. */
const WAITING_ON_US: ConversationStatus[] = [ConversationStatus.open, ConversationStatus.pending_agent];

@Injectable()
export class SupportAgentService {
  private readonly logger = new Logger(SupportAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly realtime: SupportRealtime,
  ) {}

  /**
   * One page of the queue: `urgent` first, then whoever has waited longest
   * (catalog §11.5 — priority is position, nothing else). `after` is the last
   * id of the previous page.
   */
  async inbox(
    caller: SupportCaller,
    query: { view?: InboxView; after?: string; limit?: number },
  ): Promise<{ items: AgentConversationView[]; nextAfter: string | null }> {
    const limit = Math.min(query.limit ?? PAGE_DEFAULT, PAGE_MAX);
    const view = query.view ?? 'pending';
    const where: Prisma.SupportConversationWhereInput = {
      status: { in: view === 'pending' ? WAITING_ON_US : UNFINISHED },
      ...(view === 'live' ? { mode: 'live' } : {}),
      ...(view === 'mine' ? { assignedToUserId: caller.userId } : {}),
      ...(view === 'unassigned' ? { assignedToUserId: null } : {}),
    };
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.supportConversation.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { lastMessageAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        ...(query.after ? { cursor: { id: query.after }, skip: 1 } : {}),
      });
      const page = rows.slice(0, limit);
      const unread = await unreadCounts(tx, caller, page.map((c) => c.id), true);
      return {
        items: page.map((c) => agentViewOf(c, unread.get(c.id) ?? 0)),
        nextAfter: rows.length > limit ? page[page.length - 1].id : null,
      };
    });
  }

  /** One page of a thread, notes included, oldest first — as the user's read pages. */
  async messages(
    caller: SupportCaller,
    conversationId: string,
    query: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ): Promise<AgentMessagePage> {
    const limit = Math.min(query.limit ?? PAGE_DEFAULT, PAGE_MAX);
    const page = await tenantTransaction(this.prisma, async (tx) => {
      const conversation = await tenantConversation(tx, conversationId);
      const forward = query.afterSeq !== undefined;
      const seq: Prisma.IntFilter = {};
      if (query.afterSeq !== undefined) seq.gt = query.afterSeq;
      if (query.beforeSeq !== undefined) seq.lt = query.beforeSeq;

      const rows = await tx.supportMessage.findMany({
        where: { conversationId, seq },
        orderBy: { seq: forward ? 'asc' : 'desc' },
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      if (!forward) page.reverse();
      // seq is gap-free over every message here (notes included), so seq 1 is the first.
      const hasEarlier = forward ? (page[0]?.seq ?? 1) > 1 : rows.length > limit;

      const reads = await tx.supportConversationRead.findMany({ where: { conversationId } });
      const unread = await unreadCounts(tx, caller, [conversationId], true);
      const files = await tx.supportMessageAttachment.findMany({
        where: { conversationId, messageId: { in: page.map((m) => m.id) } },
        orderBy: { createdAt: 'asc' },
      });
      const now = new Date();
      const secret = this.config.get('OBJECT_STORAGE_SIGNING_SECRET', { infer: true });
      const attachmentsOf = (messageId: string): AttachmentView[] =>
        files.filter((f) => f.messageId === messageId).map((f) => attachmentViewOf(f, now, secret));

      return {
        conversation: agentViewOf(conversation, unread.get(conversationId) ?? 0),
        messages: page.map((m) => agentMessageOf(m, caller, attachmentsOf(m.id))),
        hasEarlier,
        lastReadSeq: reads.find((r) => r.userId === caller.userId)?.lastReadSeq ?? 0,
        seenUpToSeq: reads.find((r) => r.userId === conversation.userId)?.lastReadSeq ?? 0,
      };
    });
    // Past the tenant check above: an agent of the tenant may hear the thread (F-034).
    return { ...page, realtime: await this.realtime.channelProof(caller, conversationId) };
  }

  /**
   * A reply, or with `internal` a note. A reply answers the thread — the first
   * one stamps `firstResponseAt` — hands it to the user (`pending_user`; a
   * `resolved` thread stays resolved, only the user reopens it) and claims an
   * unassigned thread for the replier (user, 2026-10-03).
   */
  async reply(caller: SupportCaller, conversationId: string, input: { body: string; internal?: boolean }): Promise<AgentMessageView> {
    const internal = input.internal === true;
    const { message, status } = await writingMessage(this.prisma, this.logger, async (tx, now) => {
      const [row] = await tx.$queryRaw<{ lastSeq: number; status: ConversationStatus }[]>`
        UPDATE support.conversation
           SET "lastSeq" = "lastSeq" + 1,
               "updatedAt" = ${now},
               "lastMessageAt" = CASE WHEN ${internal} THEN "lastMessageAt" ELSE ${now} END,
               "firstResponseAt" = CASE WHEN ${internal} THEN "firstResponseAt" ELSE COALESCE("firstResponseAt", ${now}) END,
               "assignedToUserId" = CASE WHEN ${internal} THEN "assignedToUserId"
                                         ELSE COALESCE("assignedToUserId", ${caller.userId}::uuid) END,
               status = CASE WHEN ${internal} OR status = 'resolved'::support."ConversationStatus" THEN status
                             ELSE 'pending_user'::support."ConversationStatus" END
         WHERE id = ${conversationId}::uuid
           AND status <> 'closed'::support."ConversationStatus"
        RETURNING "lastSeq", status`;
      if (!row) throw await missingOrClosed(tx, conversationId);

      const message = await tx.supportMessage.create({
        data: {
          createdAt: now,
          tenantId: caller.tenantId,
          conversationId,
          seq: row.lastSeq,
          senderKind: MessageSenderKind.agent,
          senderUserId: caller.userId,
          body: input.body,
          internal,
        },
      });
      // Replying is reading.
      await moveCursor(tx, caller, conversationId, row.lastSeq);
      return { message, status: row.status };
    });
    // Invariant 5: the user reads this channel, so a note is never on it —
    // and it carries the user-side view, which names no agent.
    if (!internal) await this.realtime.message(conversationId, viewOf(message, caller, []), status);
    return agentMessageOf(message, caller, []);
  }

  /** Hands the thread to an agent of this tenant, or with `null` back to the queue. */
  async assign(caller: SupportCaller, conversationId: string, input: { assigneeUserId: string | null }): Promise<AgentConversationView> {
    return tenantTransaction(this.prisma, async (tx) => {
      await tenantConversation(tx, conversationId);
      if (input.assigneeUserId !== null && !(await isAgent(tx, caller.tenantId, input.assigneeUserId))) {
        throw new ConversationRefused('assignee_unknown');
      }
      const updated = await tx.supportConversation.update({
        where: { id: conversationId },
        data: { assignedToUserId: input.assigneeUserId },
      });
      return agentViewOf(updated, 0);
    });
  }

  /** Done for now; the user's next message reopens it (invariant 7). A closed thread stays closed. */
  async resolve(caller: SupportCaller, conversationId: string): Promise<AgentConversationView> {
    return this.settle(conversationId, ConversationStatus.resolved, async (tx, now) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        UPDATE support.conversation
           SET status = 'resolved'::support."ConversationStatus",
               "resolvedAt" = COALESCE("resolvedAt", ${now}), "updatedAt" = ${now}
         WHERE id = ${conversationId}::uuid AND status <> 'closed'::support."ConversationStatus"
        RETURNING id`;
      if (!row) throw await missingOrClosed(tx, conversationId);
    });
  }

  /** For good: no one writes to it again; the user opens a new one (invariant 7). */
  async close(caller: SupportCaller, conversationId: string): Promise<AgentConversationView> {
    return this.settle(conversationId, ConversationStatus.closed, async (tx, now) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        UPDATE support.conversation
           SET status = 'closed'::support."ConversationStatus",
               "closedAt" = COALESCE("closedAt", ${now}), "updatedAt" = ${now}
         WHERE id = ${conversationId}::uuid
        RETURNING id`;
      if (!row) throw new ConversationRefused('not_found');
    });
  }

  /** Moves the agent's own cursor forward; the user sees "seen" (F-034). */
  async markRead(caller: SupportCaller, conversationId: string, input: { upToSeq?: number }): Promise<{ lastReadSeq: number }> {
    const result = await tenantTransaction(this.prisma, async (tx) => {
      const conversation = await tenantConversation(tx, conversationId);
      const upTo = Math.min(input.upToSeq ?? conversation.lastSeq, conversation.lastSeq);
      return { lastReadSeq: await moveCursor(tx, caller, conversationId, upTo) };
    });
    await this.realtime.read(conversationId, MessageSenderKind.agent, result.lastReadSeq);
    return result;
  }

  /** "Support is typing" to the user (F-034). Not stored. */
  async typing(caller: SupportCaller, conversationId: string): Promise<{ expiresInMs: number }> {
    const conversation = await tenantTransaction(this.prisma, (tx) => tenantConversation(tx, conversationId));
    if (conversation.status === ConversationStatus.closed) throw new ConversationRefused('closed');
    await this.realtime.typing(conversationId, MessageSenderKind.agent);
    return { expiresInMs: TYPING_TTL_MS };
  }

  private async settle(
    conversationId: string,
    status: ConversationStatus,
    write: (tx: Prisma.TransactionClient, now: Date) => Promise<void>,
  ): Promise<AgentConversationView> {
    const view = await tenantTransaction(this.prisma, async (tx) => {
      await write(tx, new Date());
      return agentViewOf(await tenantConversation(tx, conversationId), 0);
    });
    await this.realtime.status(conversationId, status);
    return view;
  }
}

/** Any conversation of the bound tenant — RLS is the whole check (§11.6). */
async function tenantConversation(tx: Prisma.TransactionClient, id: string): Promise<ConversationRow> {
  const conversation = await tx.supportConversation.findFirst({ where: { id } });
  if (!conversation) throw new ConversationRefused('not_found');
  return conversation;
}

async function missingOrClosed(tx: Prisma.TransactionClient, id: string): Promise<ConversationRefused> {
  const exists = await tx.supportConversation.findFirst({ where: { id }, select: { id: true } });
  return new ConversationRefused(exists ? 'closed' : 'not_found');
}

/**
 * An active account of this tenant whose role holds `support.agent` (or `*`).
 * The tenant is matched explicitly as well as by RLS: an assignee from another
 * tenant must answer exactly as a missing one.
 */
async function isAgent(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok
      FROM identity."user" u
      JOIN identity.role_permission rp ON rp."roleId" = u."roleId"
      JOIN identity.permission p ON p.id = rp."permissionId"
     WHERE u.id = ${userId}::uuid
       AND u."tenantId" = ${tenantId}::uuid
       AND u."deletedAt" IS NULL
       AND u.status = 'active'::identity."UserStatus"
       AND p.key IN (${SUPPORT_AGENT_PERMISSION}, '*')
     LIMIT 1`;
  return rows.length > 0;
}

function agentViewOf(c: ConversationRow, unread: number): AgentConversationView {
  return {
    ...summaryOf(c, unread),
    userId: c.userId,
    assignedToUserId: c.assignedToUserId,
    firstResponseAt: c.firstResponseAt,
    resolvedAt: c.resolvedAt,
    closedAt: c.closedAt,
  };
}

function agentMessageOf(m: MessageRow, caller: SupportCaller, attachments: AttachmentView[]): AgentMessageView {
  return { ...viewOf(m, caller, attachments), internal: m.internal, senderUserId: m.senderUserId };
}
