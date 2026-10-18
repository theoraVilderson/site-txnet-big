import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogOffer } from '../catalog/catalog-reads';
import { OffersController } from './invoice.controller';
import type { InvoiceService } from './invoice.service';

const offer = {
  variantId: 'v-1',
  sku: 'VPN-30D',
  price: { id: 'p-1', amount: '5', currencyCode: 'USD', effectiveFrom: new Date(0) },
  rateCards: [],
  remaining: 0,
  soldOut: true,
} as Partial<CatalogOffer> as CatalogOffer;

describe('GET /billing/offers answers what is left (F-513-c, F-514-a)', () => {
  it('carries remaining and soldOut, so the shop marks a full variant and turns its buy off', async () => {
    const invoices = { forSale: vi.fn().mockResolvedValue([offer]) } as Partial<InvoiceService> as InvoiceService;
    const req = { identity: { userId: 'u-1' } } as Partial<Request> as Request;
    const [answer] = await new OffersController(invoices).list(req);
    expect(answer).toMatchObject({ variantId: 'v-1', remaining: 0, soldOut: true });
  });
});
