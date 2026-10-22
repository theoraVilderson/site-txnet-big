import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TenantDataExportStatus, type TenantDataExport } from '@prisma/client';
import { ObjectNotFound, ObjectStorage, type UploadPolicy, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { exportPlan, SqlExportRows, writeArchive } from './export-archive';
import { ARCHIVE_KEEP_MS, BUILD_LEASE_MS, BUILD_MAX_ATTEMPTS, BUILD_TIMEOUT_MS, announceExport, exportPath } from './data-export.rules';

/** Written by this service, never uploaded; the cap only bounds a runaway tenant (as support's archives, F-033-n). */
const ARCHIVE_POLICY: UploadPolicy = { types: ['application/gzip'], maxBytes: 1024 ** 3, visibility: 'private' };
/** Archives deleted per tick; the next tick takes the rest. */
const EXPIRE_BATCH = 50;
/** What a failure keeps of its error: enough to tell one from another, never a page of SQL. */
const REASON_MAX = 500;

export type DataExportSweep = { built: number; failed: number; expired: number };

/**
 * The drain of tenants' data exports (F-212-a, catalog §14.8), one tick of
 * worker-service's `tenant_data_export_drain` over
 * `POST /api/internal/tenant/data-exports/drain`.
 *
 * Each tick deletes the archives past their days, then builds **one** export:
 * the oldest queued, or a build whose lease ran out (failed after
 * {@link BUILD_MAX_ATTEMPTS}). The archive is read in one REPEATABLE READ
 * transaction in the tenant's scope — one snapshot, so a ledger row and the
 * balance it moved agree — then stored, then the row is marked ready.
 *
 * **Safe twice**: a claim is an update guarded by the row's status and attempt
 * count, so two ticks cannot both take it, and the ready mark is guarded the
 * same way. Finding work is on the cross-tenant pool; everything that touches
 * the tenant's rows is in its own scope.
 */
@Injectable()
export class TenantDataExportDrain {
  private readonly logger = new Logger(TenantDataExportDrain.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly storage: ObjectStorage,
  ) {}

  async drain(now = new Date()): Promise<DataExportSweep> {
    const expired = await this.expire(now);
    const claimed = await this.claim(now);
    if (!claimed) return { built: 0, failed: 0, expired };
    if (claimed.attempts > BUILD_MAX_ATTEMPTS) {
      await this.fail(claimed, 'build abandoned: its lease ran out on every attempt', now);
      return { built: 0, failed: 1, expired };
    }
    try {
      await this.build(claimed, now);
      return { built: 1, failed: 0, expired };
    } catch (e) {
      this.logger.error(`data export ${claimed.id} of ${claimed.tenantId} failed: ${(e as Error).message}`);
      await this.fail(claimed, (e as Error).message, now);
      return { built: 0, failed: 1, expired };
    }
  }

  /** The oldest queued export, or a build whose lease ran out — leased to this tick, or `null`. */
  private async claim(now: Date): Promise<TenantDataExport | null> {
    const candidate = await this.crossTenant.tenantDataExport.findFirst({
      where: {
        OR: [{ status: TenantDataExportStatus.queued }, { status: TenantDataExportStatus.building, leaseUntil: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return null;
    const { count } = await this.crossTenant.tenantDataExport.updateMany({
      where: { id: candidate.id, status: candidate.status, attempts: candidate.attempts },
      data: { status: TenantDataExportStatus.building, leaseUntil: new Date(now.getTime() + BUILD_LEASE_MS), attempts: { increment: 1 } },
    });
    return count === 1 ? { ...candidate, status: TenantDataExportStatus.building, attempts: candidate.attempts + 1 } : null;
  }

  private async build(row: TenantDataExport, now: Date): Promise<void> {
    await runWithTenant({ id: row.tenantId }, async () => {
      const archive = await tenantTransaction(
        this.prisma,
        (tx) => writeArchive(new SqlExportRows(tx), exportPlan(row.tenantId), { exportId: row.id, tenantId: row.tenantId, createdAt: row.createdAt }),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: BUILD_TIMEOUT_MS },
      );
      const stored = await this.storage.put(ARCHIVE_POLICY, exportPath(row.id), archive.bytes, 'application/gzip');
      await tenantTransaction(this.prisma, async (tx) => {
        const { count } = await tx.tenantDataExport.updateMany({
          where: { id: row.id, status: TenantDataExportStatus.building, attempts: row.attempts },
          data: {
            status: TenantDataExportStatus.ready,
            objectKey: stored.key,
            sizeBytes: stored.size,
            sha256: stored.sha256,
            rowCount: archive.rowCount,
            finishedAt: now,
            expiresAt: new Date(now.getTime() + ARCHIVE_KEEP_MS),
            leaseUntil: null,
          },
        });
        if (count === 1) await announceExport(tx, row);
      });
      this.logger.log(`data export ${row.id} of ${row.tenantId} built: ${archive.rowCount} rows, ${stored.size} bytes`);
    });
  }

  private async fail(row: TenantDataExport, reason: string, now: Date): Promise<void> {
    await runWithTenant({ id: row.tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const { count } = await tx.tenantDataExport.updateMany({
          where: { id: row.id, status: TenantDataExportStatus.building, attempts: row.attempts },
          data: { status: TenantDataExportStatus.failed, failureReason: reason.slice(0, REASON_MAX), finishedAt: now, leaseUntil: null },
        });
        if (count === 1) await announceExport(tx, row);
      }),
    );
  }

  /** Ready archives past their days: the file goes, the row stays `expired` as the record. */
  private async expire(now: Date): Promise<number> {
    const due = await this.crossTenant.tenantDataExport.findMany({
      where: { status: TenantDataExportStatus.ready, expiresAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: EXPIRE_BATCH,
    });
    let expired = 0;
    for (const row of due) {
      try {
        await runWithTenant({ id: row.tenantId }, async () => {
          // File first: a failure after it leaves a row the next tick finds again, and a key already gone is no error.
          if (row.objectKey) await this.storage.delete(row.objectKey).catch((e: unknown) => {
            if (!(e instanceof ObjectNotFound)) throw e;
          });
          await tenantTransaction(this.prisma, async (tx) => {
            const { count } = await tx.tenantDataExport.updateMany({
              where: { id: row.id, status: TenantDataExportStatus.ready },
              data: { status: TenantDataExportStatus.expired, objectKey: null },
            });
            if (count === 1) await announceExport(tx, row);
          });
        });
        expired++;
      } catch (e) {
        this.logger.warn(`data export ${row.id} of ${row.tenantId} not expired: ${(e as Error).message}`);
      }
    }
    return expired;
  }
}
