import { Body, Controller, ForbiddenException, Get, HttpException, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { SetOperatingCurrencyInput, setOperatingCurrencySchema } from './operating-currency.schema';
import {
  OperatingCurrencyRefused,
  OperatingCurrencyRejection,
  OperatingCurrencyView,
  TenantOperatingCurrencyService,
} from './operating-currency.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<OperatingCurrencyRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_suspended: 403,
  reseller_not_found: 404,
  reseller_terminated: 409,
  currency_unavailable: 409,
  tenant_has_money: 409,
};

/**
 * A tenant's operating currency (F-116-a, ADR-0098 part 1):
 * `GET` / `PUT /api/tenants/:id/operating-currency`. `:id` is a reseller, or
 * the platform owner's own tenant for its staff.
 *
 * No `TenantPermissionGuard`: a reseller's owner holds no `tenant.manage`; the
 * service admits (`ResellerAccess`, or the platform's own staff).
 */
@Controller('tenants/:id/operating-currency')
export class TenantOperatingCurrencyController {
  constructor(private readonly currency: TenantOperatingCurrencyService) {}

  @Get()
  read(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<OperatingCurrencyView> {
    return refusing(() => this.currency.read(actorOf(req), id));
  }

  @Put()
  set(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setOperatingCurrencySchema)) body: SetOperatingCurrencyInput,
  ): Promise<OperatingCurrencyView> {
    return refusing(() => this.currency.set(actorOf(req), id, body.code));
  }
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof OperatingCurrencyRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    switch (STATUS[e.reason]) {
      case 403:
        throw new ForbiddenException(payload);
      case 404:
        throw new NotFoundException(payload);
      default:
        throw new HttpException(payload, HttpStatus.CONFLICT);
    }
  }
}

function actorOf(req: Request) {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
}
