import { Injectable, Logger } from '@nestjs/common';
import { GeneralExpense, GeneralExpenseTakeBack, Prisma } from '@prisma/client';
import { AdmittedReseller, ResellerAccess, ResellerAccessRefused, ResellerActor, finerThanCurrency, moneyText, operatingCurrencyOf, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { dayOf } from './analytics-days';
import { EXPENSES_SHOWN, ExpenseBody, ExpenseListQuery, ExpenseRefused, ExpenseView, ownLedgerOnly } from './analytics-expense';
import { restateCostsFrom } from './analytics-rollup-own-cost';

const viewOf = (e: GeneralExpense & { takeBack: GeneralExpenseTakeBack | null }): ExpenseView => ({
  id: e.id,
  category: e.category,
  amount: moneyText(e.amount),
  currencyCode: e.currencyCode,
  spentOn: e.spentOn.toISOString().slice(0, 10),
  months: e.months,
  note: e.note,
  createdByUserId: e.createdByUserId,
  createdAt: e.createdAt.toISOString(),
  takenBackAt: e.takeBack?.createdAt.toISOString() ?? null,
});

const NEWEST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * A tenant's general expenses (F-1001-t, contract.analytics-expenses.md): the
 * costs no panel or product carries. Read through the analytics door
 * (`analytics.read`), written through the settings one (`settings.manage`, the
 * platform's `platform.tenant.manage` on its own tenant) — an expense changes
 * what every reader is shown — and its own tenant's only (`ownLedgerOnly`).
 * History: an add or a take back is a new row, and asks the next rollup pass
 * to restate the tenant's cost rows from the expense's day, which re-announces
 * the figures (`billing.analytics.refreshed`, C-14).
 */
@Injectable()
export class AnalyticsExpenseService {
  private readonly logger = new Logger(AnalyticsExpenseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  /** The newest expenses first, taken-back ones included and marked; `before` pages past the one it names; the tenant's currency, a new one's default. */
  list(actor: ResellerActor, tenantId: string, q: ExpenseListQuery): Promise<{ expenses: ExpenseView[]; more: boolean; currencyCode: string }> {
    return this.door(this.access.for('analytics.read'), actor, tenantId, 'read', async (tx) => {
      const rows = await tx.generalExpense.findMany({
        include: { takeBack: true },
        orderBy: NEWEST,
        take: EXPENSES_SHOWN + 1,
        ...(q.before ? { cursor: { id: q.before }, skip: 1 } : {}),
      });
      return { expenses: rows.slice(0, EXPENSES_SHOWN).map(viewOf), more: rows.length > EXPENSES_SHOWN, currencyCode: await operatingCurrencyOf(tx, tenantId) };
    });
  }

  /** A new expense, in a registered currency at its places, paid no later than the tenant's today. */
  add(actor: ResellerActor, tenantId: string, body: ExpenseBody, now = new Date()): Promise<ExpenseView> {
    return this.door(this.writeDoor(), actor, tenantId, 'staffWrite', async (tx) => {
      if (!(await tx.currency.findUnique({ where: { code: body.currencyCode }, select: { code: true } }))) throw new ExpenseRefused('currency_not_registered');
      const amount = new Prisma.Decimal(body.amount);
      if (await finerThanCurrency(tx, body.currencyCode, { amount })) throw new ExpenseRefused('amount_finer_than_currency');
      const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      if (body.spentOn > dayOf(now, timezone)) throw new ExpenseRefused('spent_in_future');
      const spentOn = new Date(`${body.spentOn}T00:00:00Z`);
      const row = await tx.generalExpense.create({
        data: { tenantId, category: body.category, amount, currencyCode: body.currencyCode, spentOn, months: body.months, note: body.note ?? null, createdByUserId: actor.userId },
        include: { takeBack: true },
      });
      await restateCostsFrom(tx, tenantId, spentOn);
      this.logger.log(`tenant ${tenantId}: expense ${row.id} (${body.category}) ${body.amount} ${body.currencyCode} from ${body.spentOn} over ${body.months} month(s), by ${actor.userId}`);
      return viewOf(row);
    });
  }

  /** An expense no longer counts, from the day it was paid: a row of its own, once. */
  takeBack(actor: ResellerActor, tenantId: string, expenseId: string): Promise<ExpenseView> {
    return this.door(this.writeDoor(), actor, tenantId, 'staffWrite', async (tx) => {
      const expense = await tx.generalExpense.findUnique({ where: { id: expenseId }, include: { takeBack: true } });
      if (!expense) throw new ExpenseRefused('not_found');
      if (expense.takeBack) throw new ExpenseRefused('already_taken_back');
      const takeBack = await tx.generalExpenseTakeBack.create({ data: { expenseId, tenantId, createdByUserId: actor.userId } });
      await restateCostsFrom(tx, tenantId, expense.spentOn);
      this.logger.log(`tenant ${tenantId}: expense ${expenseId} taken back by ${actor.userId}`);
      return viewOf({ ...expense, takeBack });
    });
  }

  private writeDoor() {
    return this.access.for('settings.manage').asStaff('platform.tenant.manage');
  }

  /** Admitted by `door`, the tenant's own people only, then `work` in one tenant transaction; a second take back racing the first meets the key. */
  private async door<T>(
    door: ResellerAccess,
    actor: ResellerActor,
    tenantId: string,
    capability: 'read' | 'staffWrite',
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await door.runFiguresIncludingPlatform(actor, tenantId, capability, (admitted: AdmittedReseller) => {
        ownLedgerOnly(admitted);
        return tenantTransaction(this.prisma, work);
      });
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ExpenseRefused(e.reason);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ExpenseRefused('already_taken_back');
      throw e;
    }
  }
}
