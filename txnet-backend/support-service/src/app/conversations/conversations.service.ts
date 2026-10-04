import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AttachmentScanStatus,
  ConversationMode,
  ConversationPriority,
  ConversationStatus,
  Language,
  MessageSenderKind,
  Prisma,
} from '@prisma/client';
import { signedObjectUrl, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { Availability, SupportAvailability } from '../availability/availability';
import { NoticeTarget, SupportNotifier } from '../notify/support-notifier';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelProof, SupportRealtime, TYPING_TTL_MS } from '../realtime/support-realtime';
import { applySla } from '../sla/sla';
import { ConversationRefused, SupportCaller } from './refusal';

/**
 * The user's side of support (F-033-b, ADR-0112): open a conversation, send,
 * list, read, mark read, and the categories to open one under.
 *
 * Every call runs in `tenantTransaction`, so Row-Level Security holds the
 * tenant; this class holds the user (invariant 6) — every conversation is
 * looked up by its id **and** the caller's `userId`, and a miss is
 * `not_found` whether the thread is another user's or does not exist.
 */

export { ConversationRefused } from './refusal';
export type { ConversationRejection, SupportCaller } from './refusal';

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
  /** The user's rating, once given (F-033-k). */
  rating: { score: number; comment: string | null; ratedAt: Date } | null;
}

export interface MessageView {
  id: string;
  seq: number;
  senderKind: MessageSenderKind;
  /** The caller wrote it. An agent is shown by kind, never by account. */
  mine: boolean;
  body: string;
  createdAt: Date;
  attachments: AttachmentView[];
}

/**
 * A file on a message (F-033-c, ADR-0113). `url` is a path on the caller's
 * panel Host, valid five minutes — minted on every read, never stored — and
 * only for a file the scanner passed: `pending`, `infected` and `failed` ones
 * are listed with no way to fetch them.
 */
export interface AttachmentView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: AttachmentScanStatus;
  url: string | null;
  urlExpiresAt: Date | null;
  /** Retention deleted the file (F-033-n): listed, never fetchable. */
  expired: boolean;
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
  /**
   * Subscribe to `channel` with `proof` on the realtime socket for live
   * messages, reads and typing (F-034); `null` when that is unavailable.
   */
  realtime: ChannelProof | null;
}

export interface CategoryView {
  id: string;
  key: string;
  name: string;
}

/** Statuses a conversation is unfinished in — what the cap counts. */
export const UNFINISHED: ConversationStatus[] = [
  ConversationStatus.open,
  ConversationStatus.pending_user,
  ConversationStatus.pending_agent,
];

export const PAGE_MAX = 100;
export const PAGE_DEFAULT = 50;
const LIST_DEFAULT = 20;
const SUBJECT_MAX = 80;
/** ADR-0112 point 7: an attachment's URL lives five minutes. */
export const ATTACHMENT_URL_TTL_SEC = 300;

/** Postgres' refusal of a row whose month has no partition (no `DEFAULT` partition, ADR-0112 point 3). */
const NO_PARTITION = /no partition of relation/i;

@Injectable()
export class SupportConversationService {
  private readonly logger = new Logger(SupportConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly realtime: SupportRealtime,
    private readonly availability: SupportAvailability,
    private readonly notifier: SupportNotifier,
  ) {}

  /** Whether a human answers now, and if not when support opens (F-033-g) — the wait notice. */
  whenAnswered(caller: SupportCaller): Promise<Availability> {
    return this.availability.at(caller.tenantId);
  }

  async categories(caller: SupportCaller, lang: string): Promise<CategoryView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await visibleCategories(tx, caller.tenantId);
      return rows.map((c) => ({ id: c.id, key: c.key, name: nameIn(c.texts, lang) ?? c.key }));
    });
  }

  async open(caller: SupportCaller, input: OpenInput): Promise<ConversationSummary> {
    const mode = await this.availability.mode(caller.tenantId);
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
          mode,
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
      await applySla(tx, conversation.id, now, 'opened');
      return summaryOf(conversation, 0);
    });
  }

  async send(caller: SupportCaller, conversationId: string, input: { body: string }): Promise<MessageView> {
    const mode = await this.availability.mode(caller.tenantId);
    const { view, status, assignee } = await this.writingMessage(async (tx, now) => {
      const { message, status, assignee } = await appendUserMessage(tx, caller, conversationId, now, input.body, mode);
      return { view: viewOf(message, caller, []), status, assignee };
    });
    await this.realtime.message(conversationId, view, status);
    // After the commit and off the request: a notice never fails or slows the message (F-033-i).
    if (assignee) void this.notifier.tell(caller.tenantId, 'supportUserWrote', assignee);
    return view;
  }

  /** "The user is typing" to the thread's other readers (F-034). Not stored. */
  async typing(caller: SupportCaller, conversationId: string): Promise<{ expiresInMs: number }> {
    const conversation = await tenantTransaction(this.prisma, (tx) => ownConversation(tx, caller, conversationId));
    if (conversation.status === ConversationStatus.closed) throw new ConversationRefused('closed');
    await this.realtime.typing(conversationId, MessageSenderKind.user);
    return { expiresInMs: TYPING_TTL_MS };
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
    const page = await tenantTransaction(this.prisma, async (tx) => {
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
      const files = await tx.supportMessageAttachment.findMany({
        where: { conversationId, messageId: { in: page.map((m) => m.id) } },
        orderBy: { createdAt: 'asc' },
      });
      const now = new Date();
      const attachmentsOf = (messageId: string) =>
        files.filter((f) => f.messageId === messageId).map((f) => this.attachmentView(f, now));

      return {
        conversation: summaryOf(conversation, unread.get(conversationId) ?? 0),
        messages: page.map((m) => viewOf(m, caller, attachmentsOf(m.id))),
        hasEarlier,
        lastReadSeq: mine,
        seenUpToSeq: seen,
      };
    });
    // Only past the ownership check above: the proof is the permission (F-034).
    return { ...page, realtime: await this.realtime.channelProof(caller, conversationId) };
  }

  /** Moves the caller's cursor forward — to `upToSeq`, or to the end. Never back. */
  async markRead(caller: SupportCaller, conversationId: string, input: { upToSeq?: number }): Promise<{ lastReadSeq: number }> {
    const result = await tenantTransaction(this.prisma, async (tx) => {
      const conversation = await ownConversation(tx, caller, conversationId);
      const upTo = Math.min(input.upToSeq ?? conversation.lastSeq, conversation.lastSeq);
      return { lastReadSeq: await moveCursor(tx, caller, conversationId, upTo) };
    });
    // The agent's "seen" (F-034).
    await this.realtime.read(conversationId, MessageSenderKind.user, result.lastReadSeq);
    return result;
  }

  private attachmentView(f: AttachmentRow, now: Date): AttachmentView {
    return attachmentViewOf(f, now, this.config.get('OBJECT_STORAGE_SIGNING_SECRET', { infer: true }));
  }

  private writingMessage<T>(work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>): Promise<T> {
    return writingMessage(this.prisma, this.logger, work);
  }
}

/**
 * Runs a write that inserts a message. A month with no partition is an
 * insert error that aborts the transaction (ADR-0112 point 3): make the
 * month, then run the whole write again — once, and only for that error.
 */
export async function writingMessage<T>(
  prisma: PrismaService,
  logger: Logger,
  work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
): Promise<T> {
  const now = new Date();
  try {
    return await tenantTransaction(prisma, (tx) => work(tx, now));
  } catch (e) {
    if (!(e instanceof Error) || !NO_PARTITION.test(e.message)) throw e;
    const month = `${now.toISOString().slice(0, 7)}-01`;
    await prisma.$queryRaw`SELECT support.ensure_message_partition(${month}::date)`;
    logger.warn(`support.message had no partition for ${month}; made it`);
    return tenantTransaction(prisma, (tx) => work(tx, now));
  }
}

/**
 * Appends the caller's message to their own conversation and returns it.
 *
 * One statement takes the row lock, issues the seq and moves the status, so
 * two sends from two devices are ordered by the database (point 4). Before the
 * first agent reply the thread stays `open`; after it, the user's message hands
 * it to the agent — reopening a `resolved` one. `mode` is whether a human
 * answers right now (F-033-g), decided by the caller before the transaction.
 */
export async function appendUserMessage(
  tx: Prisma.TransactionClient,
  caller: SupportCaller,
  conversationId: string,
  now: Date,
  body: string,
  mode: ConversationMode,
): Promise<{ message: MessageRow; status: ConversationStatus; assignee: NoticeTarget | null }> {
  const [row] = await tx.$queryRaw<{ lastSeq: number; status: ConversationStatus; assignedToUserId: string | null; subject: string }[]>`
    UPDATE support.conversation
       SET "lastSeq" = "lastSeq" + 1,
           "lastMessageAt" = ${now},
           "updatedAt" = ${now},
           "resolvedAt" = NULL,
           mode = ${mode}::support."ConversationMode",
           status = CASE WHEN "firstResponseAt" IS NULL
                         THEN 'open'::support."ConversationStatus"
                         ELSE 'pending_agent'::support."ConversationStatus" END
     WHERE id = ${conversationId}::uuid
       AND "userId" = ${caller.userId}::uuid
       AND status <> 'closed'::support."ConversationStatus"
    RETURNING "lastSeq", status, "assignedToUserId", subject`;
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
      body,
    },
  });
  // Your own message is read by you.
  await moveCursor(tx, caller, conversationId, row.lastSeq);
  // The user answered: a stopped resolution clock runs again (F-033-h).
  await applySla(tx, conversationId, now, 'user_wrote');
  // The assignee hears of it (F-033-i); an unassigned thread waits in the queue.
  const assignee = row.assignedToUserId ? await noticeTarget(tx, conversationId, row.assignedToUserId, row.subject) : null;
  return { message, status: row.status, assignee };
}

/** Who to tell about a thread and how far they have read it — read in the write's transaction (F-033-i). */
export async function noticeTarget(
  tx: Prisma.TransactionClient,
  conversationId: string,
  userId: string,
  subject: string,
): Promise<NoticeTarget> {
  const read = await tx.supportConversationRead.findFirst({ where: { conversationId, userId }, select: { lastReadSeq: true } });
  return { conversationId, userId, readUpTo: read?.lastReadSeq ?? 0, subject };
}

export type ConversationRow = Prisma.SupportConversationGetPayload<object>;
export type MessageRow = Prisma.SupportMessageGetPayload<object>;
export type AttachmentRow = Prisma.SupportMessageAttachmentGetPayload<object>;

/**
 * What a reader sees of a file. The caller's ownership of the conversation was
 * checked by the read; this only decides whether the file may be fetched —
 * a URL only for a `clean` one (invariant 9).
 */
export function attachmentViewOf(f: AttachmentRow, now: Date, secret: string): AttachmentView {
  // An expired file (F-033-n) has no key and never a URL.
  const signed =
    f.scanStatus === AttachmentScanStatus.clean && f.objectKey
      ? signedObjectUrl({ key: f.objectKey, fileName: f.fileName, ttlSec: ATTACHMENT_URL_TTL_SEC, secret, now })
      : null;
  return {
    id: f.id,
    fileName: f.fileName,
    contentType: f.contentType,
    sizeBytes: f.sizeBytes,
    scanStatus: f.scanStatus,
    url: signed?.url ?? null,
    urlExpiresAt: signed?.expiresAt ?? null,
    expired: f.expiredAt !== null,
  };
}

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
export async function moveCursor(tx: Prisma.TransactionClient, caller: SupportCaller, conversationId: string, seq: number): Promise<number> {
  const [row] = await tx.$queryRaw<{ lastReadSeq: number }[]>`
    INSERT INTO support.conversation_read ("conversationId", "userId", "tenantId", "lastReadSeq", "readAt")
    VALUES (${conversationId}::uuid, ${caller.userId}::uuid, ${caller.tenantId}::uuid, ${seq}, now())
    ON CONFLICT ("conversationId", "userId") DO UPDATE
      SET "lastReadSeq" = GREATEST(support.conversation_read."lastReadSeq", EXCLUDED."lastReadSeq"),
          "readAt" = now()
    RETURNING "lastReadSeq"`;
  return row.lastReadSeq;
}

/**
 * Messages not the caller's, past the caller's cursor — per conversation.
 * Internal notes count only for an agent (`notes`); a user never has one.
 */
export async function unreadCounts(
  tx: Prisma.TransactionClient,
  caller: SupportCaller,
  ids: string[],
  notes = false,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ conversationId: string; unread: bigint }[]>`
    SELECT m."conversationId"::text AS "conversationId", count(*) AS unread
      FROM support.message m
      LEFT JOIN support.conversation_read r
        ON r."conversationId" = m."conversationId" AND r."userId" = ${caller.userId}::uuid
     WHERE m."conversationId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
       AND (m.internal = false OR ${notes})
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

export function summaryOf(c: ConversationRow, unread: number): ConversationSummary {
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
    rating: c.ratedAt && c.ratingScore !== null ? { score: c.ratingScore, comment: c.ratingComment, ratedAt: c.ratedAt } : null,
  };
}

export function viewOf(m: MessageRow, caller: SupportCaller, attachments: AttachmentView[]): MessageView {
  return {
    id: m.id,
    seq: m.seq,
    senderKind: m.senderKind,
    mine: m.senderUserId === caller.userId,
    body: m.body,
    createdAt: m.createdAt,
    attachments,
  };
}
