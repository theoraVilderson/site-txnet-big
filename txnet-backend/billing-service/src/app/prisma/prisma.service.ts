import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * `billing-service`'s connection to Postgres (F-092-a).
 *
 * The one generated client covers every schema (`prisma/domains/`,
 * `multiSchema`); what makes this billing's is that it only ever queries the
 * `billing` models — with **one exception**, added deliberately rather than
 * drifted into: `settlement/` writes `audit.admin_audit_log`, because its five
 * routes are audited admin actions and the ledger they operate on is here.
 * `domains/audit/contract.settlement.md` says why the routes did not move to
 * `auth-service` instead. Nothing else in this service reaches another schema,
 * and `grep -rn adminAuditLog billing-service/` is that claim. It connects as `DATABASE_APP_URL` for the reason
 * `auth-service`'s `PrismaService` gives: Row-Level Security does not bind a
 * table's owner, and the owner is what `DATABASE_URL` is. There is no fallback
 * to it.
 *
 * There is no cross-tenant pool here. That one exists in `auth-service` for the
 * reads that *resolve* a tenant; this service never resolves one — the gate
 * forwards it.
 */
/**
 * How long a transaction waits for a free connection before Prisma refuses it
 * (P2028). Prisma's default is 2 s; thirty purchases at once on billing's pool
 * waited longer and failed (LIVE-1-a, user 2026-10-28: pool 20, wait 10 s).
 */
const TRANSACTION_MAX_WAIT_MS = 10_000;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(datasourceUrl: string) {
    super({ datasourceUrl, transactionOptions: { maxWait: TRANSACTION_MAX_WAIT_MS } });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
