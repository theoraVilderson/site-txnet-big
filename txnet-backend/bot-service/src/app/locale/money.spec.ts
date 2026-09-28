import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { TopUpFlow } from '../flows/top-up.flow';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { BotCopy } from './bot-copy';
import { LocaleService } from './locale.service';
import { money } from './money';

/**
 * Every amount the bot shows names its currency (F-116-h4, ADR-0098 part 3).
 * A bare "100.00" read as tomans before a tenant switched to dollars, and as
 * dollars after; billing names the currency of every figure it answers, and
 * the chat has to say it too.
 */

/** The fallback table only: what a chat sees with locale-service unreachable. */
const copy = new BotCopy({ getKey: () => undefined } as unknown as LocaleService);
const say = (text: Parameters<BotCopy['text']>[1]) => copy.text('en', text);

describe('money', () => {
  it('names the currency beside the amount, by its translated name', () => {
    expect(say(money('100.00', 'USD'))).toBe('100.00 USD');
    expect(say(money('250000', 'IRT'))).toBe('250000 Toman');
  });

  it('prints a code it has no name for as the code — never a bare number', () => {
    expect(say(money('12.00', 'EUR'))).toBe('12.00 EUR');
  });

  it('leaves the amount bare only when billing named no currency at all', () => {
    expect(say(money('5.00', null))).toBe('5.00');
  });
});

describe('the top-up screens', () => {
  const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'en' };
  const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
  const GW = 'a1b2c3d4-0000-4000-8000-000000000001';
  const onAmount: NavState = { flow: 'topUp', step: 'topUp.amount', data: { gatewayId: GW, source: 'tenant', gateway: 'Zarinpal' } };

  function flowWith(billing: Partial<BillingApiClient>) {
    const auth = { refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'a', expiresIn: 900, refreshToken: 'r' })) } as unknown as Mocked<AuthApiClient>;
    const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
    return new TopUpFlow(billing as BillingApiClient, new ChatAccess(auth, sessions));
  }

  it('prices the quote in the currency billing answered it in — every line', async () => {
    const flow = flowWith({
      quote: vi.fn().mockResolvedValue(ok({
        gatewayId: GW, source: 'tenant', amount: '100.00', discount: '0.00', fee: '2.00', tax: '0.00', taxRatePercent: null,
        payable: '102.00', credited: '100.00', free: false, currencyCode: 'USD',
      })),
    });

    const result = await flow.handle({ ...ctx, text: '100' }, onAmount, null);

    expect(say(result.view.body)).toBe('Amount: 100.00 USD\nFee: 2.00 USD\nYou pay: 102.00 USD\nAdded to your wallet: 100.00 USD');
  });

  it('says what was credited and the new balance with their currency on a free top-up', async () => {
    const flow = flowWith({
      start: vi.fn().mockResolvedValue(ok({
        paymentId: 'p-2', free: true, redirectUrl: null, invoice: null, amount: '100.00', discount: '100.00', fee: '0.00', tax: '0.00',
        taxRatePercent: null, payable: '0.00', credited: '100.00', balance: '250.00', currencyCode: 'IRT',
      })),
    });

    const result = await flow.handle(ctx, { ...onAmount, step: 'topUp.confirm', data: { ...onAmount.data, amount: '100.00' } }, 'topup:pay');

    expect(say(result.view.body)).toBe('100.00 Toman was added to your wallet. Your balance is now 250.00 Toman ✅');
  });

  it('asks for the amount in the gateway’s currency, and labels each quick amount with it', async () => {
    const flow = flowWith({
      listGateways: vi.fn().mockResolvedValue(ok([
        { id: GW, source: 'tenant', displayName: 'Zarinpal', providerName: 'zarinpal', category: 'ipg', minAmount: null, maxAmount: null, presets: ['50.00'], currencyCode: 'USD' },
      ])),
    });

    const result = await flow.handle(ctx, { flow: 'topUp', step: 'topUp.gateway', data: {} }, `topup:g:tenant:${GW}`);

    expect(say(result.view.body)).toContain('USD');
    expect(say(result.view.actions![0][0].label)).toBe('50.00 USD');
  });
});
