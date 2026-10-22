import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAction, AuditTargetType, Prisma, TenantDataExportStatus, type TenantDataExport } from '@prisma/client';
import {
  type AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  type ResellerAccessRejection,
  type ResellerActor,
  signedObjectUrl,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { EXPORT_EVERY_MS, LINK_TTL_SEC } from './data-export.rules';

/**
 * A reseller takes its data (F-212-a, catalog §14.8): ask for an export, see
 * where it is, download it. `contract.data-export.md` is the contract.
 *
 * **Who.** The bare `ResellerAccess` door — the reseller's owner and the
 * platform's staff; a member holds no key that opens it, because the archive
 * is every customer the reseller has. **When.** `dataExport`, the one
 * capability every status column opens: a suspended or terminated reseller
 * takes its data too, never behind a paywall.
 *
 * **Once per 24 h** — the newest export that did not fail is the clock, read
 * under a per-tenant advisory lock so two clicks queue one export (C-29).
 */

export type DataExportView = {
  id: string;
  status: TenantDataExportStatus;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
};
export type DataExportList = { exports: DataExportView[]; nextAllowedAt: string | null };
export type DataExportLink = { url: string; expiresAt: string };

export type DataExportRejection = ResellerAccessRejection | 'export_too_soon' | 'export_not_found' | 'export_not_ready';

export class DataExportRefused extends Error {
  constructor(
    readonly reason: DataExportRejection,
    detail = '',
    /** `export_too_soon`: when the next export may be asked for. */
    readonly nextAllowedAt?: Date,
  ) {
    super(`data export refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'DataExportRefused';
  }
}

/** The caller, with the address its audit rows record. */
export type DataExportActor = ResellerActor & { ip?: string };

/** The exports a list shows: a day's worth each, so ten is over a week. */
const LIST_LIMIT = 10;
/** An audit row needs an address; a call with none records the unspecified one. */
const UNKNOWN_IP = '0.0.0.0';

@Injectable()
export class TenantDataExportService {
  private readonly logger = new Logger(TenantDataExportService.name);

  constructor(
    private readonly resellerAccess: ResellerAccess,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async list(actor: DataExportActor, tenantId: string, now = new Date()): Promise<DataExportList> {
    return this.admitted(actor, tenantId, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const rows = await tx.tenantDataExport.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: LIST_LIMIT });
        const next = await nextAllowedAt(tx, tenantId, now);
        return { exports: rows.map(viewOf), nextAllowedAt: next?.toISOString() ?? null };
      }),
    );
  }

  async request(actor: DataExportActor, tenantId: string, now = new Date()): Promise<DataExportView> {
    return this.admitted(actor, tenantId, () =>
      tenantTransaction(this.prisma, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tenant_data_export:${tenantId}`}))`;
        const next = await nextAllowedAt(tx, tenantId, now);
        if (next) throw new DataExportRefused('export_too_soon', tenantId, next);
        const row = await tx.tenantDataExport.create({ data: { tenantId, requestedByUserId: actor.userId, createdAt: now } });
        await audit(tx, actor, row, AdminAction.tenant_data_export_request, { status: row.status });
        this.logger.log(`data export ${row.id} of ${tenantId} asked for by ${actor.userId}`);
        return viewOf(row);
      }),
    );
  }

  /** A signed URL to a ready archive; minting it is the delivery, so it is the audit row (§14.8). */
  async link(actor: DataExportActor, tenantId: string, exportId: string, now = new Date()): Promise<DataExportLink> {
    return this.admitted(actor, tenantId, (reseller) =>
      tenantTransaction(this.prisma, async (tx) => {
        const row = await tx.tenantDataExport.findFirst({ where: { id: exportId, tenantId } });
        if (!row) throw new DataExportRefused('export_not_found', exportId);
        if (row.status !== TenantDataExportStatus.ready || !row.objectKey || (row.expiresAt && row.expiresAt <= now)) {
          throw new DataExportRefused('export_not_ready', `${exportId} is ${row.status}`);
        }
        const signed = signedObjectUrl({
          key: row.objectKey,
          fileName: `${reseller.slug}-data-${row.createdAt.toISOString().slice(0, 10)}.jsonl.gz`,
          ttlSec: LINK_TTL_SEC,
          secret: this.config.get('OBJECT_STORAGE_SIGNING_SECRET', { infer: true }),
          now,
        });
        await audit(tx, actor, row, AdminAction.tenant_data_export_delivery, { sha256: row.sha256, linkExpiresAt: signed.expiresAt.toISOString() });
        this.logger.log(`data export ${row.id} of ${tenantId} handed to ${actor.userId}`);
        return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
      }),
    );
  }

  private async admitted<T>(actor: DataExportActor, tenantId: string, work: (reseller: AdmittedReseller) => Promise<T>): Promise<T> {
    try {
      return await this.resellerAccess.run(actor, tenantId, 'dataExport', work);
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new DataExportRefused(e.reason, tenantId);
      throw e;
    }
  }
}

/** When the next export may be asked for, or `null` if now. */
async function nextAllowedAt(tx: Prisma.TransactionClient, tenantId: string, now: Date): Promise<Date | null> {
  const last = await tx.tenantDataExport.findFirst({
    where: { tenantId, status: { not: TenantDataExportStatus.failed }, createdAt: { gt: new Date(now.getTime() - EXPORT_EVERY_MS) } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return last ? new Date(last.createdAt.getTime() + EXPORT_EVERY_MS) : null;
}

async function audit(tx: Prisma.TransactionClient, actor: DataExportActor, row: TenantDataExport, action: AdminAction, newValue: Prisma.InputJsonObject): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      tenantId: row.tenantId,
      adminId: actor.userId,
      action,
      targetEntityType: AuditTargetType.tenant_data_export,
      targetEntityId: row.id,
      newValue,
      adminIpAddress: actor.ip ?? UNKNOWN_IP,
    },
    select: { id: true },
  });
}

function viewOf(row: TenantDataExport): DataExportView {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    sizeBytes: row.sizeBytes,
    rowCount: row.rowCount,
  };
}
