import { Injectable } from '@nestjs/common';
import { ResellerAccess, ResellerAccessRefused, type ResellerActor, type TenantCapabilityName } from '@txnet-backend/shared-core';

import { PAYMENT_CONFIRM_MANUAL } from './manual-confirm.controller';
import { ResellerManualConfirmRefused } from './manual-confirm.refusals';
import { type ManualActor, type ManualAnswer, ManualConfirmService, type VerifyingPaymentView } from './manual-confirm.service';

/** The caller, as the controller reads them: who, from where, holding what. */
export type ResellerManualActor = ResellerActor & { ip: string };

/**
 * A named reseller's payments to confirm (F-093-v):
 * `/api/billing/tenants/:tenantId/payments/manual`, as F-066-w3 is for its
 * gateways. **A door and a scope, and no rules**: `ResellerAccess` admits the
 * reseller's owner — a user of the platform's tenant who holds no
 * `payment.confirm_manual` — one of its seats holding that key, or the
 * platform's staff, and opens the reseller's scope; `ManualConfirmService`
 * then runs with the reseller as the actor's tenant, so its scope rule (a
 * tenant's own users, on its own gateway configs) holds unchanged.
 *
 * `read` for the list, so a suspended reseller still sees what waits;
 * `staffWrite` for every act on a payment.
 */
@Injectable()
export class ResellerManualConfirmService {
  constructor(
    private readonly access: ResellerAccess,
    private readonly manual: ManualConfirmService,
  ) {}

  list(actor: ResellerManualActor, tenantId: string): Promise<VerifyingPaymentView[]> {
    return this.run(actor, tenantId, 'read', (as) => this.manual.list(as));
  }

  inquire(actor: ResellerManualActor, tenantId: string, paymentId: string): Promise<ManualAnswer> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.manual.inquire(as, paymentId));
  }

  confirm(actor: ResellerManualActor, tenantId: string, paymentId: string, input: { referenceId?: string; reason: string }): Promise<ManualAnswer> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.manual.confirm(as, paymentId, input));
  }

  attachAuthority(actor: ResellerManualActor, tenantId: string, paymentId: string, authority: string): Promise<ManualAnswer> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.manual.attachAuthority(as, paymentId, authority));
  }

  reject(actor: ResellerManualActor, tenantId: string, paymentId: string, input: { reason: string; resubmit?: boolean }): Promise<ManualAnswer> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.manual.reject(as, paymentId, input));
  }

  /** Admit, open the reseller's scope, then work; the work `await`s inside it, as `runWithTenant` requires. */
  private async run<T>(actor: ResellerManualActor, tenantId: string, capability: TenantCapabilityName, work: (as: ManualActor) => Promise<T>): Promise<T> {
    try {
      return await this.access
        .for(PAYMENT_CONFIRM_MANUAL)
        .run(actor, tenantId, capability, (reseller) => work({ adminId: actor.userId, tenantId: reseller.id, ip: actor.ip }));
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerManualConfirmRefused(e.reason, tenantId);
      throw e;
    }
  }
}
