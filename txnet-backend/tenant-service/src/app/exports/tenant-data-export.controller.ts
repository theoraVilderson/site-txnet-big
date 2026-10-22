import { Controller, Get, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { TenantDataExportDrain, type DataExportSweep } from './tenant-data-export.drain';
import {
  type DataExportActor,
  type DataExportLink,
  type DataExportList,
  DataExportRefused,
  type DataExportRejection,
  type DataExportView,
  TenantDataExportService,
} from './tenant-data-export.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<DataExportRejection, HttpStatus> = {
  not_allowed: HttpStatus.FORBIDDEN,
  reseller_suspended: HttpStatus.FORBIDDEN,
  reseller_not_found: HttpStatus.NOT_FOUND,
  reseller_terminated: HttpStatus.CONFLICT,
  export_too_soon: HttpStatus.TOO_MANY_REQUESTS,
  export_not_found: HttpStatus.NOT_FOUND,
  export_not_ready: HttpStatus.CONFLICT,
};

/**
 * A reseller's data export (F-212-a, catalog §14.8; `contract.data-export.md`):
 * `GET` / `POST /api/tenants/:id/data-exports` and
 * `POST .../data-exports/:exportId/link`.
 *
 * `dataExport` on every route, so `TenantStatusGuard` lets a suspended
 * reseller's own staff through as `ResellerAccess` does its owner; no
 * `PlatformPermissionGuard` — the owner holds no platform key.
 */
@Controller('tenants/:id/data-exports')
export class TenantDataExportController {
  constructor(private readonly exports: TenantDataExportService) {}

  @Get()
  @TenantCapability('dataExport')
  list(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<DataExportList> {
    return refusing(() => this.exports.list(actorOf(req), id));
  }

  /** 202: the archive is built by the drain; the page hears `tenant.data_export.changed`. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @TenantCapability('dataExport')
  request(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<DataExportView> {
    return refusing(() => this.exports.request(actorOf(req), id));
  }

  @Post(':exportId/link')
  @HttpCode(HttpStatus.OK)
  @TenantCapability('dataExport')
  link(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
  ): Promise<DataExportLink> {
    return refusing(() => this.exports.link(actorOf(req), id, exportId));
  }
}

/** worker-service's `tenant_data_export_drain` tick. Service callers only. */
@Controller('internal/tenant/data-exports')
@UseGuards(ServiceOnlyGuard)
export class TenantDataExportInternalController {
  constructor(private readonly drain: TenantDataExportDrain) {}

  @Post('drain')
  @HttpCode(HttpStatus.OK)
  run(): Promise<DataExportSweep> {
    return this.drain.drain();
  }
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof DataExportRefused)) throw e;
    throw new HttpException({ reason: e.reason, message: e.message, nextAllowedAt: e.nextAllowedAt?.toISOString() }, STATUS[e.reason]);
  }
}

function actorOf(req: Request): DataExportActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions, ip: req.ip };
}
