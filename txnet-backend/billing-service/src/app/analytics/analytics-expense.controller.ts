import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { RefusalStatus, refusalException } from '../request/refusal-exception';
import { ExpenseBody, ExpenseListQuery, ExpenseRefusal, ExpenseRefused, expenseListSchema, expenseSchema } from './analytics-expense';
import { AnalyticsExpenseService } from './analytics-expense.service';
import { READ } from './analytics.controller';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ExpenseRefusal, RefusalStatus> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  not_found: 404,
  already_taken_back: 409,
  currency_not_registered: 400,
  amount_finer_than_currency: 400,
  spent_in_future: 400,
};

/**
 * A tenant's general expenses (F-1001-t, contract.analytics-expenses.md
 * "Routes"): `/api/billing/tenants/:tenantId/analytics/expenses`, beside the
 * tabs. The doors are in the service. Rare: the analytics read bucket bounds them.
 */
@Controller('billing/tenants/:tenantId/analytics/expenses')
export class AnalyticsExpenseController {
  constructor(private readonly expenses: AnalyticsExpenseService) {}

  @Get()
  @RateLimit(READ)
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(expenseListSchema)) q: ExpenseListQuery, @Req() req: Request) {
    return refusing(() => this.expenses.list(actorOf(req), tenantId, q));
  }

  @Post()
  @RateLimit(READ)
  add(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(expenseSchema)) body: ExpenseBody, @Req() req: Request) {
    return refusing(() => this.expenses.add(actorOf(req), tenantId, body));
  }

  /** No longer counts from the day it was paid; the row stays, marked. */
  @Post(':id/take-back')
  @HttpCode(200)
  @RateLimit(READ)
  takeBack(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.expenses.takeBack(actorOf(req), tenantId, id));
  }
}

const actorOf = (req: Request) => {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
};

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof ExpenseRefused)) throw e;
    throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message });
  }
}
