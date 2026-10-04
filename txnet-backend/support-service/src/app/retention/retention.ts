import { gzipSync } from 'node:zlib';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  ObjectDriver,
  ObjectNotFound,
  ObjectStorage,
  UploadPolicy,
  prismaStoredObjects,
  runWithTenant,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { SUPPORT_OBJECT_DRIVER } from '../conversations/attachments.service';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

const DAY = 86_400_000;
/** Files expired per run; the next run takes the rest. */
const FILE_BATCH = 500;
/** An archive is written by this service, never uploaded; the cap only bounds a runaway month. */
const ARCHIVE_POLICY: UploadPolicy = { types: ['application/gzip'], maxBytes: 1024 ** 3, visibility: 'private' };
const PARTITION = /^message_(\d{4})_(\d{2})$/;

/** One archived message: the row, with what its files were (never their keys). */
type ArchiveLine = {
  id: string;
  tenantId: string;
  conversationId: string;
  seq: number;
  senderKind: string;
  senderUserId: string | null;
  body: string;
  internal: boolean;
  createdAt: string;
  attachments: { fileName: string; contentType: string; sizeBytes: number; expired: boolean }[];
};

/** `YYYY-MM` of a month's first day. */
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
/** The archive's logical path for a month, per tenant (the tenant is the key's prefix). */
export const archivePath = (month: string) => `support/archive/messages-${month}.jsonl.gz`;

/**
 * Retention (F-033-n, user 2026-10-04), run by worker-service's daily
 * `support_retention` over `POST /api/internal/support/retention`.
 *
 * **Files.** An attachment of a conversation closed more than
 * `SUPPORT_ATTACHMENT_RETENTION_DAYS` (90) ago loses its file: the row keeps
 * its name, type and size with `objectKey` NULL and `expiredAt` set, the
 * stored object (row and bytes) goes. Each file in its own tenant's
 * transaction, so one failure leaves the rest done.
 *
 * **Months.** A `support.message` partition older than
 * `SUPPORT_MESSAGE_RETENTION_MONTHS` (12) whole months is archived — one gzip
 * JSONL per tenant at `support/archive/messages-YYYY-MM.jsonl.gz`, private, on
 * the storage port — its attachment rows and files removed, then the partition
 * detached and dropped (`support.drop_message_partition`, ADR-0112 point 3).
 * A month whose archive failed for any tenant is not dropped; a rerun rewrites
 * the archives (a put replaces) and tries again. The conversation rows stay.
 *
 * Scans run on the cross-tenant pool (no request carries a tenant); every
 * write is in the row's own tenant transaction on the app pool.
 */
@Injectable()
export class SupportRetention {
  private readonly logger = new Logger(SupportRetention.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
    @Inject(SUPPORT_OBJECT_DRIVER) private readonly driver: ObjectDriver,
  ) {}

  async run(now = new Date()): Promise<{ expired: number; months: string[] }> {
    const { expired } = await this.expireAttachments(now);
    const { months } = await this.archiveMonths(now);
    return { expired, months };
  }

  async expireAttachments(now = new Date()): Promise<{ expired: number }> {
    const days = this.config.get('SUPPORT_ATTACHMENT_RETENTION_DAYS', { infer: true });
    const cutoff = new Date(now.getTime() - days * DAY);
    const due = await this.crossTenant.$queryRaw<{ id: string; tenantId: string; objectKey: string }[]>`
      SELECT a.id, a."tenantId", a."objectKey"
        FROM support.message_attachment a
        JOIN support.conversation c ON c.id = a."conversationId"
       WHERE a."expiredAt" IS NULL
         AND c.status = 'closed'
         AND c."closedAt" < ${cutoff}
       LIMIT ${FILE_BATCH}`;
    let expired = 0;
    for (const file of due) {
      try {
        const done = await runWithTenant({ id: file.tenantId }, () =>
          tenantTransaction(this.prisma, async (tx) => {
            const { count } = await tx.supportMessageAttachment.updateMany({
              where: { id: file.id, expiredAt: null },
              data: { objectKey: null, expiredAt: now },
            });
            if (count === 0) return false;
            await this.deleteObject(tx, file.objectKey);
            return true;
          }),
        );
        if (done) expired++;
      } catch (e) {
        this.logger.warn(`attachment ${file.id} not expired: ${(e as Error).message}`);
      }
    }
    return { expired };
  }

  async archiveMonths(now = new Date()): Promise<{ months: string[] }> {
    const keep = this.config.get('SUPPORT_MESSAGE_RETENTION_MONTHS', { infer: true });
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keep, 1));
    const partitions = await this.crossTenant.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = 'support' AND p.relname = 'message'`;
    const due = partitions
      .map(({ name }) => PARTITION.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)))
      .filter((from) => from < cutoff)
      .sort((a, b) => a.getTime() - b.getTime());

    const months: string[] = [];
    for (const from of due) {
      const month = monthOf(from);
      try {
        await this.archiveMonth(from, month);
        months.push(month);
      } catch (e) {
        this.logger.error(`support messages of ${month} not archived, partition kept: ${(e as Error).message}`);
      }
    }
    return { months };
  }

  private async archiveMonth(from: Date, month: string): Promise<void> {
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const tenants = await this.crossTenant.$queryRaw<{ tenantId: string }[]>`
      SELECT DISTINCT "tenantId" FROM support.message WHERE "createdAt" >= ${from} AND "createdAt" < ${to}`;
    for (const { tenantId } of tenants) {
      const lines = await this.linesOf(tenantId, from, to);
      const archive = gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8'));
      await runWithTenant({ id: tenantId }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          await new ObjectStorage(this.driver, prismaStoredObjects(tx)).put(ARCHIVE_POLICY, archivePath(month), archive, 'application/gzip');
          // The month's files go with it: rows first (they reference the objects), then each object.
          const files = await tx.supportMessageAttachment.findMany({
            where: { messageCreatedAt: { gte: from, lt: to } },
            select: { objectKey: true },
          });
          await tx.supportMessageAttachment.deleteMany({ where: { messageCreatedAt: { gte: from, lt: to } } });
          for (const f of files) if (f.objectKey) await this.deleteObject(tx, f.objectKey);
        }),
      );
    }
    await this.crossTenant.$queryRaw`SELECT support.drop_message_partition(${from}::date)`;
    this.logger.log(`support messages of ${month} archived for ${tenants.length} tenant(s) and dropped`);
  }

  private async linesOf(tenantId: string, from: Date, to: Date): Promise<ArchiveLine[]> {
    const rows = await this.crossTenant.$queryRaw<(Omit<ArchiveLine, 'createdAt'> & { createdAt: Date })[]>`
      SELECT m.id, m."tenantId", m."conversationId", m.seq, m."senderKind"::text AS "senderKind", m."senderUserId",
             m.body, m.internal, m."createdAt",
             COALESCE(json_agg(json_build_object(
               'fileName', a."fileName", 'contentType', a."contentType", 'sizeBytes', a."sizeBytes",
               'expired', a."expiredAt" IS NOT NULL) ORDER BY a."createdAt") FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
        FROM support.message m
        LEFT JOIN support.message_attachment a ON a."messageId" = m.id AND a."messageCreatedAt" = m."createdAt"
       WHERE m."tenantId" = ${tenantId}::uuid AND m."createdAt" >= ${from} AND m."createdAt" < ${to}
       GROUP BY m.id, m."createdAt"
       ORDER BY m."conversationId", m.seq`;
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /** The stored object's row and bytes; one already gone is not an error (a rerun after a partial failure). */
  private async deleteObject(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await new ObjectStorage(this.driver, prismaStoredObjects(tx)).delete(key).catch((e: unknown) => {
      if (!(e instanceof ObjectNotFound)) throw e;
    });
  }
}
