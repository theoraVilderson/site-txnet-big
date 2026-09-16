import type { MockInstance } from 'vitest';
import { invoiceParams, parsePaymentEvent, type Invoice } from './payment';
import {
  TelegramLikeBotClient,
  WEBHOOK_ALLOWED_UPDATES,
} from './telegram-like-bot.client';

/**
 * The invoice rail (F-104-l, D-32). What it turns on: a caller above this unit
 * describes one invoice and reads one pair of events, and never learns that
 * Telegram and Bale take different fields — Telegram names a currency and a
 * Stars invoice carries no provider token; Bale prices in Rials, names no
 * currency and always needs its wallet token (both read 2026-09-16).
 */
describe('invoice rail', () => {
  const stars: Invoice = {
    title: 'Wallet top-up',
    description: '10 USD to your wallet',
    payload: 'p_0b6c',
    currency: 'XTR',
    prices: [{ label: 'Top-up', amount: 500 }],
  };
  const rials: Invoice = {
    ...stars,
    currency: 'IRR',
    prices: [{ label: 'Top-up', amount: 6_000_000 }],
    providerToken: 'WALLET-TOKEN',
  };

  describe('invoiceParams', () => {
    it('sends Telegram Stars with a currency and no provider token', () => {
      expect(invoiceParams('telegram', stars)).toEqual({
        ok: true,
        params: {
          title: 'Wallet top-up',
          description: '10 USD to your wallet',
          payload: 'p_0b6c',
          currency: 'XTR',
          prices: [{ label: 'Top-up', amount: 500 }],
        },
      });
    });

    it('refuses a Stars invoice that carries a token or more than one price', () => {
      expect(invoiceParams('telegram', { ...stars, providerToken: 't' })).toEqual({
        ok: false,
        reason: 'provider_token_forbidden',
      });
      expect(
        invoiceParams('telegram', {
          ...stars,
          prices: [...stars.prices, { label: 'Fee', amount: 1 }],
        }),
      ).toEqual({ ok: false, reason: 'invalid_prices' });
    });

    it('needs a provider token for any other Telegram currency', () => {
      expect(invoiceParams('telegram', { ...stars, currency: 'USD' })).toEqual({
        ok: false,
        reason: 'provider_token_required',
      });
    });

    it('sends Bale its wallet token and no currency field', () => {
      expect(invoiceParams('bale', rials)).toEqual({
        ok: true,
        params: {
          title: 'Wallet top-up',
          description: '10 USD to your wallet',
          payload: 'p_0b6c',
          provider_token: 'WALLET-TOKEN',
          prices: [{ label: 'Top-up', amount: 6_000_000 }],
        },
      });
    });

    it('refuses Bale anything but Rials with a token', () => {
      expect(invoiceParams('bale', { ...rials, currency: 'XTR' })).toEqual({
        ok: false,
        reason: 'currency_unsupported',
      });
      expect(
        invoiceParams('bale', { ...rials, providerToken: undefined }),
      ).toEqual({ ok: false, reason: 'provider_token_required' });
    });

    it('refuses what neither platform accepts', () => {
      for (const bad of [
        { ...stars, title: '' },
        { ...stars, title: 'x'.repeat(33) },
        { ...stars, description: 'x'.repeat(256) },
        { ...stars, payload: 'ی'.repeat(65) }, // 130 bytes
      ]) {
        expect(invoiceParams('telegram', bad)).toEqual({
          ok: false,
          reason: 'invalid_field',
        });
      }
      for (const amount of [0, -1, 1.5]) {
        expect(
          invoiceParams('telegram', { ...stars, prices: [{ label: 'x', amount }] }),
        ).toEqual({ ok: false, reason: 'invalid_prices' });
      }
    });
  });

  describe('parsePaymentEvent', () => {
    it('reads a pre_checkout_query the same on both platforms', () => {
      for (const currency of ['XTR', 'IRR']) {
        expect(
          parsePaymentEvent({
            update_id: 1,
            pre_checkout_query: {
              id: 'q1',
              from: { id: 42 },
              currency,
              total_amount: 500,
              invoice_payload: 'p_0b6c',
            },
          }),
        ).toEqual({
          kind: 'pre_checkout',
          queryId: 'q1',
          fromId: '42',
          currency,
          totalAmount: 500,
          payload: 'p_0b6c',
        });
      }
    });

    it('reads a successful_payment with the platform charge id as the reference', () => {
      expect(
        parsePaymentEvent({
          message: {
            message_id: 9,
            from: { id: 42 },
            chat: { id: 42 },
            successful_payment: {
              currency: 'XTR',
              total_amount: 500,
              invoice_payload: 'p_0b6c',
              telegram_payment_charge_id: 'tg-charge',
              provider_payment_charge_id: '',
            },
          },
        }),
      ).toEqual({
        kind: 'payment_succeeded',
        chatId: '42',
        fromId: '42',
        currency: 'XTR',
        totalAmount: 500,
        payload: 'p_0b6c',
        platformChargeId: 'tg-charge',
        providerChargeId: null,
      });
    });

    it('answers null for anything else, or a payment missing its proof', () => {
      expect(parsePaymentEvent({ message: { text: '/start' } })).toBeNull();
      expect(
        parsePaymentEvent({
          message: {
            chat: { id: 1 },
            from: { id: 1 },
            successful_payment: {
              currency: 'XTR',
              total_amount: 500,
              invoice_payload: 'p',
            } as never,
          },
        }),
      ).toBeNull();
    });
  });

  describe('client', () => {
    let fetchMock: MockInstance;
    const ok = (result: unknown) =>
      ({ ok: true, json: async () => ({ ok: true, result }) }) as unknown as Response;
    const bodyOf = (i: number) =>
      JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string);

    beforeEach(() => {
      fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(ok({ message_id: 7 }));
    });
    afterEach(() => fetchMock.mockRestore());

    it('registers pre_checkout_query — without it the payment times out', () => {
      expect(WEBHOOK_ALLOWED_UPDATES).toContain('pre_checkout_query');
      expect(
        TelegramLikeBotClient.deliversEveryUpdate(['message', 'callback_query']),
      ).toBe(false);
    });

    it('sends the platform-shaped invoice to the chat', async () => {
      const bale = new TelegramLikeBotClient('bale', 'https://b.test', 'T', 1000);
      await expect(bale.sendInvoice('42', rials)).resolves.toEqual({
        ok: true,
        messageId: 7,
      });
      expect(fetchMock.mock.calls[0][0]).toBe('https://b.test/botT/sendInvoice');
      expect(bodyOf(0)).toEqual({
        chat_id: '42',
        ...(invoiceParams('bale', rials) as { params: object }).params,
      });
    });

    it('refuses without calling the platform', async () => {
      const tg = new TelegramLikeBotClient('telegram', 'https://t.test', 'T', 1000);
      await expect(tg.sendInvoice('42', { ...rials, providerToken: undefined })).resolves.toEqual({
        ok: false,
        reason: 'provider_token_required',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('creates an invoice link, and reports a platform failure without throwing', async () => {
      const tg = new TelegramLikeBotClient('telegram', 'https://t.test', 'T', 1000);
      fetchMock.mockResolvedValueOnce(ok('https://t.me/$abc'));
      await expect(tg.createInvoiceLink(stars)).resolves.toEqual({
        ok: true,
        link: 'https://t.me/$abc',
      });
      fetchMock.mockRejectedValueOnce(new Error('down'));
      await expect(tg.sendInvoice('42', stars)).resolves.toEqual({
        ok: false,
        reason: 'platform_error',
      });
    });

    it('answers a pre-checkout query, with the reason only on a refusal', async () => {
      const tg = new TelegramLikeBotClient('telegram', 'https://t.test', 'T', 1000);
      fetchMock.mockResolvedValue(ok(true));
      await expect(tg.answerPreCheckoutQuery('q1', { ok: true })).resolves.toBe(true);
      await tg.answerPreCheckoutQuery('q1', { ok: false, errorMessage: 'Expired' });
      expect(bodyOf(0)).toEqual({ pre_checkout_query_id: 'q1', ok: true });
      expect(bodyOf(1)).toEqual({
        pre_checkout_query_id: 'q1',
        ok: false,
        error_message: 'Expired',
      });
    });
  });
});
