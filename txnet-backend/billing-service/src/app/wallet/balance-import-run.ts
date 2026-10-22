import { Injectable } from '@nestjs/common';
import { MigrationRunKind, MigrationRunStatus } from '@prisma/client';
import { ResellerAccess, tenantTransaction, type ResellerActor } from '@txnet-backend/shared-core';

import { admitMigration } from '../entitlement/migration-door';
import { writeReport } from '../entitlement/migration-preview';
import { MigrationRunRefused } from '../entitlement/migration-run';
import { runView, type MigrationRunView } from '../entitlement/migration-run-view';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceFileRefused, parseBalanceFile, type BalanceRow } from './balance-import';
import { balancePlanOf } from './balance-import-plan';

/** The write of a whole file's report: up to `BALANCE_ROWS_MAX` items in one transaction, so the report is all or nothing. */
const REPORT_WRITE_TIMEOUT_MS = 60_000;

/**
 * A reseller's balances from a file (F-209-a, billing
 * `contract.balance-import.md`), on the import engine: a `csv` run whose dry
 * run is made at once — the file is the whole source, there is nothing to
 * read — then confirmed, committed and rolled back as any run. The door is
 * the import's: `migration.manage`, `staffWrite`.
 */
@Injectable()
export class BalanceImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  /** The run and its report in one transaction; a file no row can be read from makes no run. Nothing outside the run's tables is written (invariant 32). */
  create(actor: ResellerActor, tenantId: string, csv: string): Promise<MigrationRunView> {
    return admitMigration(this.access, { actor, tenantId, capability: 'staffWrite' }, async () => {
      let rows: BalanceRow[];
      try {
        rows = parseBalanceFile(csv);
      } catch (e) {
        if (e instanceof BalanceFileRefused) throw new MigrationRunRefused(e.reason);
        throw e;
      }
      return tenantTransaction(
        this.prisma,
        async (tx) => {
          const run = await tx.migrationRun.create({ data: { tenantId, kind: MigrationRunKind.csv, actorUserId: actor.userId, status: MigrationRunStatus.previewing } });
          // The run was made in this transaction, unleased: the report is written under that same `stillOurs`.
          await writeReport(tx, run, await balancePlanOf(tx, tenantId, rows));
          return runView(await tx.migrationRun.findUniqueOrThrow({ where: { id: run.id } }));
        },
        { timeout: REPORT_WRITE_TIMEOUT_MS },
      );
    });
  }
}
