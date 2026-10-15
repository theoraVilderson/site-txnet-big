import { ConfigService } from '@nestjs/config';

import { BotCopy } from '../locale/bot-copy';
import { BillingApiClient, BillingCallContext } from './billing-api.client';

/**
 * Where the bank sends a chat's payer back to (diagnosed 2026-10-15). A start
 * from the chat has no browser, so billing captured no `Origin`, kept no
 * `returnOrigin`, and the callback's relative `/payment/success` landed on the
 * API host — a 404 after a payment that went through. The start names the
 * panel the chat already opens (`PANEL_BASE_URL`); billing still decides
 * whether to trust it (`returnOriginOf`).
 */
const call: BillingCallContext = { lang: 'fa', accessToken: 'a', platform: 'telegram', botTenantId: 't1' };
const body = { gatewayId: 'g1', source: 'tenant' as const, amount: '100' };

function client(env: Record<string, string>) {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
    sent.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ ok: true, msg: 'ok', data: {} }), { headers: { 'content-type': 'application/json' } });
  });
  return { sent, api: new BillingApiClient(new ConfigService({ BILLING_API_BASE_URL: 'http://billing', ...env }), {} as BotCopy) };
}

afterEach(() => vi.unstubAllGlobals());

describe('BillingApiClient.start', () => {
  it("names the panel's origin, so the bank sends the payer back to the panel", async () => {
    const { api, sent } = client({ PANEL_BASE_URL: 'https://panel.example.test/app?x=1' });
    await api.start(body, call);
    expect(sent[0].headers['origin']).toBe('https://panel.example.test');
  });

  // F-093-u: the bot's own link, so the result page offers the way back to it.
  it('names the bot the top-up started in, when it is given one', async () => {
    const { api, sent } = client({});
    await api.start(body, call, 'https://t.me/txnet_bot?start=paid');
    expect(sent[0].headers['x-bot-return-link']).toBe('https://t.me/txnet_bot?start=paid');
  });

  it('names none where no panel is published, and only on start', async () => {
    const { api, sent } = client({});
    await api.start(body, call);
    expect(sent[0].headers['origin']).toBeUndefined();

    const withPanel = client({ PANEL_BASE_URL: 'https://panel.example.test' });
    await withPanel.api.quote(body, call);
    expect(withPanel.sent[0].headers['origin']).toBeUndefined();
  });
});
