import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationMode,
  ConversationPriority,
  ConversationStatus,
  Language,
  MessageSenderKind,
  Prisma,
} from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The user's side of support (F-033-b, ADR-0112): open a conversation, send,
 * list, read, mark read, and the categories to open one under.
 *
 * Every call runs in `tenantTransaction`, so Row-Level Security holds the
 * tenant; this class holds the user (invariant 6) — every conversation is
 * looked up by its id **and** the caller's `userId`, and a miss is
 * `not_found` whether the thread is another user's or does not exist.
 */

export type ConversationRejection = 'not_found' | 'closed' | 'category_unknown' | 'too_many_unfinished';

export class ConversationRefused extends Error {
  constructor(readonly reason: ConversationRejection) {
    super(`support conversation refused: ${reason}`);
    this.name = 'ConversationRefused';
  }
}

export interface SupportCaller {
  tenantId: string;
  userId: string;
}

export interface OpenInput {
  body: string;
  subject?: string;
  categoryId?: string;
}

export interface ConversationSummary {
  id: string;
  subject: string;
  categoryId: string | null;
  status: ConversationStatus;
  mode: ConversationMode;
  priority: ConversationPriority;
  lastSeq: number;
  lastMessageAt: Date;
  createdAt: Date;
  unread: number;
}

export interface MessageView {
  id: string;
  seq: number;
  senderKind: MessageSenderKind;
  /** The caller wrote it. An agent is shown by kind, never by account. */
  mine: boolean;
  body: string;
  createdAt: Date;
}

export interface MessagePage {
  conversation: ConversationSummary;
  messages: MessageView[];
  /** More messages exist before the first one returned. */
  hasEarlier: boolean;
  /** The caller's cursor. */
  lastReadSeq: number;
  /** The furthest any other reader (an agent) has read — "seen". */
  seenUpToSeq: number;
}

export interface CategoryView {
  id: string;
  key: string;
  name: string;
}

/** Statuses a conversation is unfinished in — what the cap counts. */
const UNFINISHED: ConversationStatus[] = [
  ConversationStatus.open,
  ConversationStatus.pending_user,
  ConversationStatus.pending_agent,
];

export const PAGE_MAX = 100;
const PAGE_DEFAULT = 50;
const LIST_DEFAULT = 20;
const SUBJECT_MAX = 80;

/** Postgres' refusal of a row whose month has no partition (no `DEFAULT` partition, ADR-0112 point 3). */
const NO_PARTITION = /no partition of relation/i;

@Injectable()
export class SupportConversationService {
  private readonly logger = new Logger(SupportConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async categories(caller: SupportCaller, lang: string): Promise<CategoryView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await visibleCategories(tx, caller.tenantId);
      return rows.map((c) => ({ id: c.id, key: c.key, name: nameIn(c.texts, lang) ?? c.key }));
    });
  }

  async open(caller: SupportCaller, input: OpenInput): Promise<ConversationSummary> {
    return this.writingMessage(async (tx, now) => {
      const unfinished = await tx.supportConversation.count({
        where: { userId: caller.userId, status: { in: UNFINISHED } },
      });
      if (unfinished >= this.config.get('SUPPORT_UNFINISHED_MAX', { infer: true })) {
        throw new ConversationRefused('too_many_unfinished');
      }
      if (input.categoryId) {
        const visible = await visibleCategories(tx, caller.tenantId);
        if (!visible.some((c) => c.id === input.categoryId)) throw new ConversationRefused('category_unknown');
      }

      const conversation = await tx.supportConversation.create({
        data: {
          tenantId: caller.tenantId,
          userId: caller.userId,
          subject: input.subject?.trim() || subjectFrom(input.body),
          categoryId: input.categoryId ?? null,
          lastSeq: 1,
          lastMessageAt: now,
          createdAt: now,
        },
      });
      await tx.supportMessage.create({
        data: {
          createdAt: now,
          tenantId: caller.tenantId,
          conversationId: conversation.id,
          seq: 1,
          senderKind: MessageSenderKind.user,
          senderUserId: caller.userId,
          body: input.body,
        },
      });
      await moveCursor(tx, caller, conversation.id, 1);
      return summaryOf(conversation, 0);
    });
  }

  async send(caller: SupportCaller, conversationId: string, input: { body: string }): Promise<MessageView> {
    return this.writingMessage(async (tx, now) => {
      // One statement takes the row lock, issues the seq and moves the status,
      // so two sends from two devices are ordered by the database (point 4).
      // Before the first agent reply the thread stays `open`; after it, the
      // user's message hands it to the agent — reopening a `resolved` one.
      const [row] = await tx.$queryRaw<{ lastSeq: number }[]>`
        UPDATE support.conversation
           SET "lastSeq" = "lastSeq" + 1,
               "lastMessageAt" = ${now},
               "updatedAt" = ${now},
               "resolvedAt" = NULL,
               status = CASE WHEN "firstResponseAt" IS NULL
                             THEN 'open'::support."ConversationStatus"
                             ELSE 'pending_agent'::support."ConversationStatus" END
         WHERE id = ${conversationId}::uuid
           AND "userId" = ${caller.userId}::uuid
           AND status <> 'closed'::support."ConversationStatus"
        RETURNING "lastSeq"`;
      if (!row) {
        const exists = await tx.supportConversation.findFirst({
          where: { id: conversationId, userId: caller.userId },
          select: { id: true },
        });
        throw new ConversationRefused(exists ? 'closed' : 'not_found');
      }

      const message = await tx.supportMessage.create({
        data: {
          createdAt: now,
          tenantId: caller.tenantId,
          conversationId,
          seq: row.lastSeq,
          senderKind: MessageSenderKind.user,
          senderUserId: caller.userId,
          body: input.body,
        },
      });
      // Your own message is read by you.
      await moveCursor(tx, caller, conversationId, row.lastSeq);
      return viewOf(message, caller);
    });
  }

  async list(
    caller: SupportCaller,
    query: { before?: Date; limit?: number },
  ): Promise<{ items: ConversationSummary[]; nextBefore: Date | null }> {
    const limit = Math.min(query.limit ?? LIST_DEFAULT, PAGE_MAX);
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.supportConversation.findMany({
        where: { userId: caller.userId, ...(query.before ? { lastMessageAt: { lt: query.before } } : {}) },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const unread = await unreadCounts(tx, caller, page.map((c) => c.id));
      return {
        items: page.map((c) => summaryOf(c, unread.get(c.id) ?? 0)),
        nextBefore: rows.length > limit ? page[page.length - 1].lastMessageAt : null,
      };
    });
  }

  /**
   * One page of a conversation, oldest first. With neither bound it is the
   * latest page; `beforeSeq` pages back, `afterSeq` fetches what is new.
   */
  async messages(
    caller: SupportCaller,
    conversationId: string,
    query: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ): Promise<MessagePage> {
    const limit = Math.min(query.limit ?? PAGE_DEFAULT, PAGE_MAX);
    return tenantTransaction(this.prisma, async (tx) => {
      const conversation = await ownConversation(tx, caller, conversationId);
      const forward = query.afterSeq !== undefined;
      const seq: Prisma.IntFilter = {};
      if (query.afterSeq !== undefined) seq.gt = query.afterSeq;
      if (query.beforeSeq !== undefined) seq.lt = query.beforeSeq;

      const rows = await tx.supportMessage.findMany({
        // Invariant 5: an agent's note is never on a user's page.
        where: { conversationId, internal: false, seq },
        orderBy: { seq: forward ? 'asc' : 'desc' },
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      if (!forward) page.reverse();
      const hasEarlier = forward
        ? (page[0] ? (await tx.supportMessage.count({ where: { conversationId, internal: false, seq: { lt: page[0].seq } } })) > 0 : false)
        : rows.length > limit;

      const reads = await tx.supportConversationRead.findMany({ where: { conversationId } });
      const mine = reads.find((r) => r.userId === caller.userId)?.lastReadSeq ?? 0;
      const seen = Math.max(0, ...reads.filter((r) => r.userId !== caller.userId).map((r) => r.lastReadSeq));
      const unread = await unreadCounts(tx, caller, [conversationId]);

      return {
        conversation: summaryOf(conversation, unread.get(conversationId) ?? 0),
        messages: page.map((m) => viewOf(m, caller)),
        hasEarlier,
        lastReadSeq: mine,
        seenUpToSeq: seen,
      };
    });
  }

  /** Moves the caller's cursor forward — to `upToSeq`, or to the end. Never back. */
  async markRead(caller: SupportCaller, conversationId: string, input: { upToSeq?: number }): Promise<{ lastReadSeq: number }> {
    return tenantTransaction(this.prisma, async (tx) => {
      const conversation = await ownConversation(tx, caller, conversationId);
      const upTo = Math.min(input.upToSeq ?? conversation.lastSeq, conversation.lastSeq);
      return { lastReadSeq: await moveCursor(tx, caller, conversationId, upTo) };
    });
  }

  /**
   * Runs a write that inserts a message. A month with no partition is an
   * insert error that aborts the transaction (ADR-0112 point 3): make the
   * month, then run the whole write again — once, and only for that error.
   */
  private async writingMessage<T>(work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>): Promise<T> {
    const now = new Date();
    try {
      return await tenantTransaction(this.prisma, (tx) => work(tx, now));
    } catch (e) {
      if (!(e instanceof Error) || !NO_PARTITION.test(e.message)) throw e;
      const month = `${now.toISOString().slice(0, 7)}-01`;
      await this.prisma.$queryRaw`SELECT support.ensure_message_partition(${month}::date)`;
      this.logger.warn(`support.message had no partition for ${month}; made it`);
      return tenantTransaction(this.prisma, (tx) => work(tx, now));
    }
  }
}

type ConversationRow = Prisma.SupportConversationGetPayload<object>;
type MessageRow = Prisma.SupportMessageGetPayload<object>;

async function ownConversation(tx: Prisma.TransactionClient, caller: SupportCaller, id: string): Promise<ConversationRow> {
  const conversation = await tx.supportConversation.findFirst({ where: { id, userId: caller.userId } });
  if (!conversation) throw new ConversationRefused('not_found');
  return conversation;
}

/**
 * The categories a tenant's user may open under (ADR-0112 point 6): the
 * tenant's own active ones, or — while it has none — the platform's defaults.
 */
async function visibleCategories(tx: Prisma.TransactionClient, tenantId: string) {
  const query = (owner: string | null) =>
    tx.supportCategory.findMany({
      where: { tenantId: owner, isActive: true },
      include: { texts: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
  const own = await query(tenantId);
  return own.length > 0 ? own : query(null);
}

/** The name in `lang`, else in the reference language, else any. */
function nameIn(texts: { lang: Language; name: string }[], lang: string): string | undefined {
  return (
    texts.find((t) => t.lang === lang)?.name ??
    texts.find((t) => t.lang === Language.fa)?.name ??
    texts[0]?.name
  );
}

/** Ups the cursor to `seq` unless it is already past it; returns where it stands. */
async function moveCursor(tx: Prisma.TransactionClient, caller: SupportCaller, conversationId: string, seq: number): Promise<number> {
  const [row] = await tx.$queryRaw<{ lastReadSeq: number }[]>`
    INSERT INTO support.conversation_read ("conversationId", "userId", "tenantId", "lastReadSeq", "readAt")
    VALUES (${conversationId}::uuid, ${caller.userId}::uuid, ${caller.tenantId}::uuid, ${seq}, now())
    ON CONFLICT ("conversationId", "userId") DO UPDATE
      SET "lastReadSeq" = GREATEST(support.conversation_read."lastReadSeq", EXCLUDED."lastReadSeq"),
          "readAt" = now()
    RETURNING "lastReadSeq"`;
  return row.lastReadSeq;
}

/** Messages not the caller's, not internal, past the caller's cursor — per conversation. */
async function unreadCounts(tx: Prisma.TransactionClient, caller: SupportCaller, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ conversationId: string; unread: bigint }[]>`
    SELECT m."conversationId"::text AS "conversationId", count(*) AS unread
      FROM support.message m
      LEFT JOIN support.conversation_read r
        ON r."conversationId" = m."conversationId" AND r."userId" = ${caller.userId}::uuid
     WHERE m."conversationId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
       AND m.internal = false
       AND m."senderUserId" IS DISTINCT FROM ${caller.userId}::uuid
       AND m.seq > COALESCE(r."lastReadSeq", 0)
     GROUP BY m."conversationId"`;
  return new Map(rows.map((r) => [r.conversationId, Number(r.unread)]));
}

/** The first line of the body, trimmed to a subject's length. */
function subjectFrom(body: string): string {
  const line = body.trim().split(/\r?\n/, 1)[0].trim();
  return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX - 1)}…` : line;
}

function summaryOf(c: ConversationRow, unread: number): ConversationSummary {
  return {
    id: c.id,
    subject: c.subject,
    categoryId: c.categoryId,
    status: c.status,
    mode: c.mode,
    priority: c.priority,
    lastSeq: c.lastSeq,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
    unread,
  };
}

function viewOf(m: MessageRow, caller: SupportCaller): MessageView {
  return {
    id: m.id,
    seq: m.seq,
    senderKind: m.senderKind,
    mine: m.senderUserId === caller.userId,
    body: m.body,
    createdAt: m.createdAt,
  };
}
