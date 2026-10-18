import type { Prisma, QuotaOverageMode } from '@prisma/client';
import { moneyText, overageTermsOf, type QuotaOverageTerms } from '@txnet-backend/shared-core';

import type { HeldOverage, OverageView } from './reseller-limits.service';

type OverageRow = { mode: QuotaOverageMode; unitPrice: Prisma.Decimal | null; currencyCode: string | null };

/** An overage's terms as the API answers them: the price at every place it holds (F-116-r). */
export function overageView(terms: QuotaOverageTerms): OverageView {
  return { mode: terms.mode, unitPrice: terms.unitPrice ? moneyText(terms.unitPrice) : null, currencyCode: terms.currencyCode };
}

/** A stored overage row as the API answers it. */
export function viewOf(row: OverageRow): OverageView {
  return overageView(overageTermsOf(row));
}

/** What an audit row records as the overage before a write: its view, or `unset`. */
export function held(row: OverageRow | null): HeldOverage {
  return row ? viewOf(row) : 'unset';
}
