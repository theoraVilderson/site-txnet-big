import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackendI18nKeys, I18nExceptionFilter, ResellerQuotaExhausted } from '@txnet-backend/shared-core';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocaleService } from '../locale/locale.service';
import { GiftController } from '../payment/gift/gift.controller';
import type { GiftRedemptionService } from '../payment/gift/gift-redemption.service';
import type { InvoicePaymentService } from './invoice-payment.service';
import { InvoiceController } from './invoice.controller';
import type { InvoiceService } from './invoice.service';

/**
 * What the buyer hears when the reseller's package quota for a product refuses
 * the sale (F-019-v11, ADR-0107 point 11): "not available now", in their
 * language, and nothing of the reseller's package — no meter, no figures — at
 * the invoice, at its payment and at a gift code. The real locale files are
 * read, so a missing fa/en sentence fails here.
 */
const LOCALES = resolve(__dirname, '../../../../../locales/backend/langs');
const errors = (lang: string) => JSON.parse(readFileSync(resolve(LOCALES, lang, 'errors.json'), 'utf8'));
const KEY = BackendI18nKeys.errors.billing.invoice.notAvailableNow;
const textOf = (lang: string): unknown => KEY.split('.').reduce((node, part) => node?.[part], errors(lang));

const locale = {
  getKey: (lang: string, ns: string, key: string) => (ns === 'errors' && key === KEY ? textOf(lang) : undefined),
  getDefaultLanguage: () => 'fa',
} as unknown as LocaleService;

/** One refusal past a product's quota: 3 of 3 included, under `stop`. */
const refusal = () => new ResellerQuotaExhausted('product:prod-7', 'stop', 3, 3);

const req = (language: string) => ({ language, identity: { userId: 'buyer-1', tenantId: 'reseller-1' }, headers: {}, method: 'POST', originalUrl: '/x' }) as unknown as Request;

/** The envelope the buyer's client receives: the app's own filter, over the controller's throw. */
async function answer(act: () => Promise<unknown>, language: string) {
  const thrown = await act().then(
    () => expect.unreachable('the sale was refused'),
    (e: unknown) => e,
  );
  let status = 0;
  let body: Record<string, unknown> = {};
  const response = {
    status: (s: number) => ((status = s), response),
    json: (b: Record<string, unknown>) => (body = b),
  };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => req(language) }) } as unknown as ArgumentsHost;
  new I18nExceptionFilter(locale).catch(thrown, host);
  return { status, body };
}

describe('a product quota refuses the buyer (F-019-v11)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const invoices = { create: vi.fn(async () => Promise.reject(refusal())) } as unknown as InvoiceService;
  const payments = { pay: vi.fn(async () => Promise.reject(refusal())) } as unknown as InvoicePaymentService;
  const invoice = new InvoiceController(invoices, payments, locale, { get: () => undefined } as unknown as ConfigService);
  const gift = new GiftController({ redeem: vi.fn(async () => Promise.reject(refusal())) } as unknown as GiftRedemptionService);

  const acts: [string, (r: Request) => Promise<unknown>][] = [
    ['at the invoice', (r) => invoice.create({ variantId: 'v-1', couponCodes: [] } as never, r)],
    ['at its payment', (r) => invoice.pay('00000000-0000-4000-8000-000000000001', r)],
    ['at a gift code', (r) => gift.redeem({ code: 'GIFT-1' } as never, r)],
  ];

  it.each(['fa', 'en'])('the sentence exists in %s', (lang) => {
    expect(typeof textOf(lang)).toBe('string');
    expect(String(textOf(lang)).length).toBeGreaterThan(0);
  });

  for (const [where, act] of acts) {
    it.each(['fa', 'en'])(`${where}: 409, "not available now" in %s, and nothing of the reseller's package`, async (lang) => {
      const { status, body } = await answer(() => act(req(lang)), lang);
      expect(status).toBe(409);
      expect(body['msg']).toBe(textOf(lang));
      expect(body['error']).toEqual({ reason: 'reseller_quota_exhausted' });
      const sent = JSON.stringify(body);
      expect(sent).not.toContain('prod-7');
      expect(sent).not.toContain('stop');
      expect(sent).not.toMatch(/included|used/);
    });
  }
});
