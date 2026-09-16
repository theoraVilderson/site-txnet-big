import { BadGatewayException, BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { BotKeys } from '../locale/bot-keys';
import { InvoiceLinkController } from './invoice-link.controller';

/**
 * A Mini App's invoice link (F-104-q): billing asks, the tenant's own bot on
 * that messenger makes it, exactly as the chat's invoice is sent (F-104-m).
 */
const body = {
  tenantId: 'tenant-1',
  platform: 'bale',
  paymentId: 'payment-1',
  currency: 'IRR',
  amountMinor: '20200000',
  providerToken: 'bale-wallet-token',
  credited: '20.00',
  lang: 'fa',
};

function build(opts: { client?: 'none' | 'refuses' } = {}) {
  const seen: { primary: unknown[]; invoices: unknown[]; texts: unknown[] } = { primary: [], invoices: [], texts: [] };
  const client = {
    createInvoiceLink: async (invoice: unknown) => {
      seen.invoices.push(invoice);
      return opts.client === 'refuses' ? { ok: false, reason: 'platform_error' } : { ok: true, link: 'link-1' };
    },
  };
  const bots = {
    primaryClient: async (...args: unknown[]) => {
      seen.primary.push(args);
      return opts.client === 'none' ? null : client;
    },
  };
  const copy = {
    text: (lang: string, text: { key: string; values?: Record<string, string> }) => {
      seen.texts.push({ lang, ...text });
      return `${lang}:${text.key}`;
    },
  };
  return { controller: new InvoiceLinkController(bots as never, copy as never), seen };
}

describe('InvoiceLinkController', () => {
  it("makes the link with the tenant's primary bot, in the payer's language, token and payload intact", async () => {
    const { controller, seen } = build();

    await expect(controller.create(body)).resolves.toEqual({ link: 'link-1' });
    expect(seen.primary).toEqual([['tenant-1', 'bale', 'bot-app:InvoiceLink']]);
    expect(seen.invoices).toEqual([
      {
        title: `fa:${BotKeys.topUp.invoiceTitle}`,
        description: `fa:${BotKeys.topUp.invoiceDescription}`,
        payload: 'payment-1',
        currency: 'IRR',
        prices: [{ label: `fa:${BotKeys.topUp.invoiceLabel}`, amount: 20200000 }],
        providerToken: 'bale-wallet-token',
      },
    ]);
    expect(seen.texts).toContainEqual({ lang: 'fa', key: BotKeys.topUp.invoiceDescription, values: { credited: '20.00' } });
  });

  it('sends no provider token for a provider that takes none (Stars)', async () => {
    const { controller, seen } = build();
    await controller.create({ ...body, platform: 'telegram', currency: 'XTR', amountMinor: '770', providerToken: null });
    expect(seen.invoices[0]).not.toHaveProperty('providerToken');
  });

  it('refuses a body it cannot read, a tenant with no usable bot, and a platform that made no link', async () => {
    await expect(build().controller.create({ ...body, platform: 'whatsapp' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build().controller.create({ ...body, amountMinor: '12.5' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ client: 'none' }).controller.create(body)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(build({ client: 'refuses' }).controller.create(body)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
