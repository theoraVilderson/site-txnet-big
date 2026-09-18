import type { Mocked } from 'vitest';
import { aBotIntegration, TelegramLikeBotClient } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import { ChatContext } from '../conversation/nav.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { InChatPayment } from './in-chat-payment';

/**
 * The bot's half of an in-chat payment (F-104-m, D-32).
 *
 * What would break silently here, and nowhere else:
 *  - **every pre-checkout query is answered**, whatever billing says or fails
 *    to say — an unanswered one is a payment the platform cancels in 10s;
 *  - **a refusal carries a sentence the payer can read**, one per reason;
 *  - **`successful_payment` is relayed with the platform's charge id** and its
 *    result is said in the chat — and money that did not credit is never told
 *    it was, only that it is being checked.
 */
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const base: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '42', senderId: 42, lang: 'fa' };
const preCheckout: ChatContext = {
  ...base,
  payment: { kind: 'pre_checkout', queryId: 'q1', fromId: '42', currency: 'XTR', totalAmount: 770, payload: PAYMENT },
};
const succeeded: ChatContext = {
  ...base,
  payment: {
    kind: 'payment_succeeded',
    chatId: '42',
    fromId: '42',
    currency: 'XTR',
    totalAmount: 770,
    payload: PAYMENT,
    platformChargeId: 'tg-charge-1',
    providerChargeId: null,
  },
};
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });

function harness(over: { billing?: Partial<BillingApiClient>; session?: unknown } = {}) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as AuthApiClient;
  const sessions = {
    get: vi.fn().mockResolvedValue('session' in over ? over.session : { refreshToken: 'r-1', signedInAt: 0 }),
    save: vi.fn(),
    clear: vi.fn(),
  } as unknown as BotSessionStore;
  const billing = {
    preCheckout: vi.fn().mockResolvedValue(ok({ approved: true })),
    paid: vi.fn().mockResolvedValue(ok({ status: 'credited', credited: '10.00' })),
    ...over.billing,
  } as unknown as Mocked<BillingApiClient>;
  const copy = {
    text: (_lang: string, t: { key?: string; values?: Record<string, string> }) =>
      `${t.key}${t.values ? JSON.stringify(t.values) : ''}`,
  } as unknown as BotCopy;
  const client = {
    answerPreCheckoutQuery: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue(1),
  } as unknown as Mocked<TelegramLikeBotClient>;
  return { billing, client, handler: new InChatPayment(billing, new ChatAccess(auth, sessions), copy) };
}

const call = { lang: 'fa', accessToken: 'access-1', platform: 'telegram', botTenantId: base.integration.tenantId };

describe('InChatPayment', () => {
  it('approves the query billing approves, relaying exactly what the platform reported', async () => {
    const { handler, billing, client } = harness();

    await handler.handle(preCheckout, client);

    expect(billing.preCheckout).toHaveBeenCalledWith({ paymentId: PAYMENT, currency: 'XTR', totalAmount: '770' }, call);
    expect(client.answerPreCheckoutQuery).toHaveBeenCalledWith('q1', { ok: true });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses with one readable reason per billing refusal', async () => {
    const reasons: Array<[string, string]> = [
      ['not_found', BotKeys.topUp.refusedNotFound],
      ['not_payable', BotKeys.topUp.refusedNotPayable],
      ['amount_mismatch', BotKeys.topUp.refusedAmount],
    ];
    for (const [reason, key] of reasons) {
      const { handler, client } = harness({
        billing: { preCheckout: vi.fn().mockResolvedValue(ok({ approved: false, reason })) },
      });
      await handler.handle(preCheckout, client);
      expect(client.answerPreCheckoutQuery).toHaveBeenCalledWith('q1', { ok: false, errorMessage: key });
    }
  });

  it('still answers when billing cannot be reached or the chat is signed out', async () => {
    const down = harness({ billing: { preCheckout: vi.fn().mockResolvedValue({ ok: false, msg: 'try again' }) } });
    await down.handler.handle(preCheckout, down.client);
    expect(down.client.answerPreCheckoutQuery).toHaveBeenCalledWith('q1', { ok: false, errorMessage: BotKeys.common.tryAgain });

    const signedOut = harness({ session: null });
    await signedOut.handler.handle(preCheckout, signedOut.client);
    expect(signedOut.billing.preCheckout).not.toHaveBeenCalled();
    expect(signedOut.client.answerPreCheckoutQuery).toHaveBeenCalledWith('q1', {
      ok: false,
      errorMessage: BotKeys.common.notSignedIn,
    });
  });

  it('relays a successful payment with the charge id and says what reached the wallet', async () => {
    const { handler, billing, client } = harness();

    await handler.handle(succeeded, client);

    expect(billing.paid).toHaveBeenCalledWith(
      { paymentId: PAYMENT, currency: 'XTR', totalAmount: '770', chargeId: 'tg-charge-1' },
      call,
    );
    expect(client.sendMessage).toHaveBeenCalledWith('42', `${BotKeys.topUp.paidCredited}{"credited":"10.00"}`);
  });

  it('never says credited for money that did not credit — it is being checked', async () => {
    for (const answer of [ok({ status: 'unsettled', credited: null }), ok({ status: 'not_found', credited: null }), { ok: false, msg: 'x' }]) {
      const { handler, client } = harness({ billing: { paid: vi.fn().mockResolvedValue(answer) } });
      await handler.handle(succeeded, client);
      expect(client.sendMessage).toHaveBeenCalledWith('42', BotKeys.topUp.paidPending);
    }
  });
});
