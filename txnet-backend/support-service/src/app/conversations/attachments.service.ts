import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttachmentScanStatus } from '@prisma/client';
import {
  ObjectDriver,
  ObjectRejected,
  ObjectStorage,
  SniffableType,
  UploadPolicy,
  VirusScanner,
  prismaStoredObjects,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { SupportAvailability } from '../availability/availability';
import type { EnvConfig } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { NoticeTarget, SupportNotifier } from '../notify/support-notifier';
import { SupportRealtime } from '../realtime/support-realtime';
import {
  ConversationRefused,
  MessageView,
  SupportCaller,
  appendUserMessage,
  attachmentViewOf,
  viewOf,
  writingMessage,
} from './conversations.service';

/**
 * Files on a user's message (F-033-f, ADR-0113): the user's own conversation
 * only, a cap on each file and on files per message, a storage quota per user,
 * and every file past the virus scanner before it is stored.
 *
 * The order is the point. Everything that can refuse without writing — the
 * shape, the scan — runs first; the bytes, the message and the attachment rows
 * then go in one transaction that also holds the quota, and a refusal or a
 * failure inside it removes the bytes it wrote. An infected file is never on
 * the volume, not even for a moment.
 */

export const SUPPORT_OBJECT_DRIVER = Symbol('SUPPORT_OBJECT_DRIVER');
export const SUPPORT_VIRUS_SCANNER = Symbol('SUPPORT_VIRUS_SCANNER');

/** Screenshots and documents (catalog §11.4). Never SVG or HTML: nothing that can run. */
export const ATTACHMENT_TYPES = ['image/png', 'image/webp', 'image/jpeg', 'application/pdf'] as const satisfies readonly SniffableType[];

const EXTENSION: Record<(typeof ATTACHMENT_TYPES)[number], string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
};

const FILE_NAME_MAX = 120;

export interface IncomingFile {
  /** As the client named it; only ever shown and offered as the download's name. */
  originalName: string;
  contentType: string;
  bytes: Buffer;
}

@Injectable()
export class SupportAttachmentService {
  private readonly logger = new Logger(SupportAttachmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
    @Inject(SUPPORT_OBJECT_DRIVER) private readonly driver: ObjectDriver,
    @Inject(SUPPORT_VIRUS_SCANNER) private readonly scanner: VirusScanner,
    private readonly realtime: SupportRealtime,
    private readonly availability: SupportAvailability,
    private readonly notifier: SupportNotifier,
  ) {}

  async send(caller: SupportCaller, conversationId: string, input: { body?: string; files: IncomingFile[] }): Promise<MessageView> {
    const body = (input.body ?? '').trim();
    const maxBytes = this.config.get('SUPPORT_ATTACHMENT_MAX_BYTES', { infer: true });
    if (!body && input.files.length === 0) throw new ConversationRefused('empty_message');
    if (input.files.length > this.config.get('SUPPORT_ATTACHMENTS_PER_MESSAGE', { infer: true })) {
      throw new ConversationRefused('too_many_files');
    }
    for (const f of input.files) {
      if (!isAttachmentType(f.contentType)) throw new ConversationRefused('file_rejected');
      if (f.bytes.length > maxBytes) throw new ConversationRefused('file_too_large');
    }
    // A stranger's conversation is refused before their bytes cost a scan.
    await this.assertOwn(caller, conversationId);
    await this.scanAll(caller, input.files);

    const planned = input.files.map((f) => {
      const id = randomUUID();
      const type = f.contentType as (typeof ATTACHMENT_TYPES)[number];
      return { id, file: f, path: `support/${conversationId}/${id}.${EXTENSION[type]}` };
    });
    const incoming = input.files.reduce((sum, f) => sum + f.bytes.length, 0);
    const policy: UploadPolicy = { types: ATTACHMENT_TYPES, maxBytes, visibility: 'private' };
    const secret = this.config.get('OBJECT_STORAGE_SIGNING_SECRET', { infer: true });
    const written: string[] = [];

    const mode = await this.availability.mode(caller.tenantId);
    let sent: { view: MessageView; status: string; assignee: NoticeTarget | null };
    try {
      sent = await writingMessage(this.prisma, this.logger, async (tx, now) => {
        if (incoming > 0) {
          // One upload of this user at a time past this point, so two cannot
          // both read the same total and both fit under the quota.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`support-quota:${caller.userId}`}))`;
          const [{ used }] = await tx.$queryRaw<{ used: bigint }[]>`
            SELECT COALESCE(SUM(a."sizeBytes"), 0)::bigint AS used
              FROM support.message_attachment a
              JOIN support.conversation c ON c.id = a."conversationId"
             WHERE c."userId" = ${caller.userId}::uuid
               AND a."expiredAt" IS NULL`;
          if (Number(used) + incoming > this.config.get('SUPPORT_STORAGE_QUOTA_BYTES', { infer: true })) {
            throw new ConversationRefused('quota_exceeded');
          }
        }

        const { message, status, assignee } = await appendUserMessage(tx, caller, conversationId, now, body, mode);
        const storage = new ObjectStorage(this.driver, prismaStoredObjects(tx));
        const rows = [];
        for (const p of planned) {
          const put = await storage.put(policy, p.path, p.file.bytes, p.file.contentType).catch((e: unknown) => {
            if (e instanceof ObjectRejected) {
              throw new ConversationRefused(e.reason === 'too_large' ? 'file_too_large' : 'file_rejected');
            }
            throw e;
          });
          written.push(put.key);
          rows.push(
            await tx.supportMessageAttachment.create({
              data: {
                id: p.id,
                tenantId: caller.tenantId,
                conversationId,
                messageId: message.id,
                messageCreatedAt: message.createdAt,
                objectKey: put.key,
                fileName: cleanFileName(p.file.originalName, EXTENSION[p.file.contentType as keyof typeof EXTENSION]),
                contentType: p.file.contentType,
                sizeBytes: put.size,
                scanStatus: AttachmentScanStatus.clean,
              },
            }),
          );
        }
        return { view: viewOf(message, caller, rows.map((r) => attachmentViewOf(r, now, secret))), status, assignee };
      });
    } catch (e) {
      // The rows went with the transaction; the bytes are this code's to take back.
      await Promise.allSettled(written.map((key) => this.driver.remove(key)));
      throw e;
    }
    await this.realtime.message(conversationId, sent.view, sent.status);
    await this.realtime.tenant(caller.tenantId, conversationId);
    if (sent.assignee) void this.notifier.tell(caller.tenantId, 'supportUserWrote', sent.assignee);
    return sent.view;
  }

  /**
   * One file's bytes, to the conversation's own user (F-309) — for a surface
   * with no panel Host to spend a signed URL on (the bot). The same file the
   * signed URL would serve and no other: clean, not expired, on a message the
   * user sees (never an internal note). Anything else answers as missing.
   */
  async download(caller: SupportCaller, conversationId: string, attachmentId: string): Promise<{ fileName: string; contentType: string; bytes: Buffer }> {
    const file = await tenantTransaction(this.prisma, (tx) =>
      tx.supportMessageAttachment.findFirst({
        where: {
          id: attachmentId,
          conversationId,
          scanStatus: AttachmentScanStatus.clean,
          expiredAt: null,
          objectKey: { not: null },
          message: { internal: false, conversation: { userId: caller.userId } },
        },
        select: { fileName: true, contentType: true, objectKey: true },
      }),
    );
    const bytes = file?.objectKey ? await this.driver.read(file.objectKey) : null;
    if (!file || !bytes) throw new ConversationRefused('not_found');
    return { fileName: file.fileName, contentType: file.contentType, bytes };
  }

  private async assertOwn(caller: SupportCaller, conversationId: string): Promise<void> {
    const found = await tenantTransaction(this.prisma, (tx) =>
      tx.supportConversation.findFirst({ where: { id: conversationId, userId: caller.userId }, select: { status: true } }),
    );
    if (!found) throw new ConversationRefused('not_found');
    if (found.status === 'closed') throw new ConversationRefused('closed');
  }

  /** Infected is refused outright; a scanner that cannot answer refuses too — retrying later may pass. */
  private async scanAll(caller: SupportCaller, files: IncomingFile[]): Promise<void> {
    for (const f of files) {
      const verdict = await this.scanner.scan(f.bytes);
      if (verdict.status === 'infected') {
        this.logger.warn(`infected upload refused: ${verdict.signature} (tenant ${caller.tenantId}, user ${caller.userId})`);
        throw new ConversationRefused('file_infected');
      }
      if (verdict.status === 'failed') {
        this.logger.error(`virus scan failed, upload refused: ${verdict.reason}`);
        throw new ConversationRefused('scan_unavailable');
      }
    }
  }
}

function isAttachmentType(type: string): type is (typeof ATTACHMENT_TYPES)[number] {
  return (ATTACHMENT_TYPES as readonly string[]).includes(type);
}

/**
 * A name fit to show and to offer as a download: no path, no control
 * characters, a bounded length. It never becomes a path — the key is the
 * attachment's id.
 */
export function cleanFileName(raw: string, extension: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f"]/g, '').replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') return `file.${extension}`;
  return name.length > FILE_NAME_MAX ? name.slice(name.length - FILE_NAME_MAX) : name;
}
