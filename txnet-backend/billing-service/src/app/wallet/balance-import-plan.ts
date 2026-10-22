import type { MigrationRun, Prisma } from '@prisma/client';
import { currencyPlacesMap, operatingCurrencyOf } from '@txnet-backend/shared-core';

import type { RunPlan } from '../entitlement/migration-run-plan';
import { balanceSnapshotSchema, planBalanceRows, type BalanceRow } from './balance-import';

/*
 * The reads a balance file's dry run plans against (F-209-a): at the create
 * (`BalanceImportService`) and again on a re-preview (`MigrationPreviewService`).
 */

/**
 * A file's report against the tenant as it is now (F-209-a): who each name
 * is — username, phone or import key, deleted people left out — and the
 * currency their money is kept in. Three reads for the whole file (C-28).
 */
export async function balancePlanOf(tx: Prisma.TransactionClient, tenantId: string, rows: readonly BalanceRow[]): Promise<RunPlan> {
  const names = [...new Set(rows.map((r) => r.user).filter((n) => n !== ''))];
  const people = await tx.user.findMany({
    where: { tenantId, deletedAt: null, OR: [{ username: { in: names } }, { phoneNumber: { in: names } }, { remoteIdentity: { in: names } }] },
    select: { id: true, username: true, phoneNumber: true, remoteIdentity: true },
  });
  const peopleOf = new Map<string, string[]>();
  for (const p of people) {
    for (const name of [p.username, p.phoneNumber, p.remoteIdentity]) if (name) peopleOf.set(name, [...(peopleOf.get(name) ?? []), p.id]);
  }
  const [wallets, tenantCurrency] = await Promise.all([
    tx.wallet.findMany({ where: { ownerUserId: { in: people.map((p) => p.id) } }, select: { ownerUserId: true, currencyCode: true } }),
    operatingCurrencyOf(tx, tenantId),
  ]);
  const walletCurrency = new Map(wallets.map((w) => [w.ownerUserId, w.currencyCode]));
  const places = await currencyPlacesMap(tx, [tenantCurrency, ...walletCurrency.values()]);
  return planBalanceRows(rows, { peopleOf, currencyOf: (userId) => walletCurrency.get(userId) ?? tenantCurrency, placesOf: (code) => places.of(code) });
}

/** A csv run's rows as its items keep them, in the file's order: what a re-preview plans again. */
export async function balanceRowsOf(tx: Prisma.TransactionClient, run: Pick<MigrationRun, 'id'>): Promise<BalanceRow[]> {
  const items = await tx.migrationItem.findMany({ where: { runId: run.id }, orderBy: { remoteIdentity: 'asc' }, select: { sourceSnapshot: true } });
  return items.flatMap((i) => {
    const row = balanceSnapshotSchema.safeParse(i.sourceSnapshot);
    return row.success ? [{ line: row.data.line, user: row.data.user, amount: row.data.amount, currency: row.data.currency }] : [];
  });
}
