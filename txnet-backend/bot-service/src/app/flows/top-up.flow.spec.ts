import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { TopUpFlow } from './top-up.flow';

const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const refused = (msg: string) => ({ ok: false, msg });

const GW = 'a1b2c3d4-0000-4000-8000-000000000001';
const GATEWAYS = [
  { id: GW, source: 'tenant', displayName: 'Zarinpal', providerName: 'zarinpal', category: 'ipg', minAmount: '10.00', maxAmount: null, presets: ['50.00', '100.00'] },
];
const QUOTE = { gatewayId: GW, source: 'tenant', amount: '100.00', discount: '0.00', fee: '2.00', payable: '102.00', credited: '100.00', free: false };

function harness(over: { session?: unknown; billing?: Partial<BillingApiClient> } = {}) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as Mocked<AuthApiClient>;
  const billing = {
    listGateways: vi.fn().mockResolvedValue(ok(GATEWAYS)),
    quote: vi.fn().mockResolvedValue(ok(QUOTE)),
    start: vi.fn().mockResolvedValue(
      ok({ paymentId: 'p-1', free: false, redirectUrl: 'https://pay.example/StartPay/A1', amount: '100.00', discount: '0.00', fee: '2.00', payable: '102.00', credited: '100.00', balance: null }),
    ),
    ...over.billing,
  } as unknown as Mocked<BillingApiClient>;
  const sessions = {
    get: vi.fn().mockResolvedValue('session' in over ? over.session : { refreshToken: 'r-1', signedInAt: 0 }),
    save: vi.fn(),
    clear: vi.fn(),
  } as unknown as BotSessionStore;
  return { billing, flow: new TopUpFlow(billing, new ChatAccess(auth, sessions)) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);
const onAmount: NavState = { flow: 'topUp', step: 'topUp.amount', data: { gatewayId: GW, source: 'tenant', gateway: 'Zarinpal' } };
const onConfirm: NavState = { flow: 'topUp', step: 'topUp.confirm', data: { ...onAmount.data, amount: '100.00' } };

describe('TopUpFlow', () => {
  it('offers every gateway billing lists, with the chat’s own access token', async () => {
    const { flow, billing } = harness();

    const result = await flow.start(ctx);

    expect(billing.listGateways).toHaveBeenCalledWith({ lang: 'fa', accessToken: 'access-1', platform: 'telegram' });
    expect(ids(result)).toContain(`topup:g:tenant:${GW}`);
    expect(result.nextState?.step).toBe('topUp.gateway');
  });

  it('says so when there is no gateway, instead of an empty keyboard', async () => {
    const { flow } = harness({ billing: { listGateways: vi.fn().mockResolvedValue(ok([])) } });

    const result = await flow.start(ctx);

    expect(result.view.id).toBe('topUp.none');
    expect(result.nextState).toBeNull();
  });

  it('offers the gateway’s own quick amounts once one is picked', async () => {
    const { flow } = harness();
    const state: NavState = { flow: 'topUp', step: 'topUp.gateway', data: {} };

    const result = await flow.handle(ctx, state, `topup:g:tenant:${GW}`);

    expect(ids(result)).toEqual(expect.arrayContaining(['topup:a:50.00', 'topup:a:100.00']));
    expect(result.nextState).toMatchObject({ step: 'topUp.amount', data: { gatewayId: GW, source: 'tenant', gateway: 'Zarinpal' } });
  });

  it('refuses a gateway the list no longer has, rather than trusting the button', async () => {
    const { flow } = harness();
    const state: NavState = { flow: 'topUp', step: 'topUp.gateway', data: {} };

    const result = await flow.handle(ctx, state, 'topup:g:tenant:someone-else');

    expect(result.nextState).toEqual(state);
  });

  it('quotes a typed amount in Persian digits as billing reads it, and shows billing’s numbers', async () => {
    const { flow, billing } = harness();

    const result = await flow.handle({ ...ctx, text: '۱۰۰' }, onAmount, null);

    expect(billing.quote).toHaveBeenCalledWith({ gatewayId: GW, source: 'tenant', amount: '100' }, { lang: 'fa', accessToken: 'access-1', platform: 'telegram' });
    expect(result.view.body).toMatchObject({ values: { payable: '102.00', fee: '2.00', credited: '100.00' } });
    expect(ids(result)).toContain('topup:pay');
    expect(result.nextState).toMatchObject({ step: 'topUp.confirm', data: { amount: '100' } });
  });

  it('keeps the user on the amount question when billing refuses it', async () => {
    const { flow } = harness({ billing: { quote: vi.fn().mockResolvedValue(refused('خارج از بازه')) } });

    const result = await flow.handle(ctx, onAmount, 'topup:a:50.00');

    expect(result.view.body).toEqual({ raw: 'خارج از بازه' });
    expect(result.nextState).toEqual(onAmount);
  });

  it('starts with exactly the quoted body and hands over the bank page as a URL button', async () => {
    const { flow, billing } = harness();

    const result = await flow.handle(ctx, onConfirm, 'topup:pay');

    expect(billing.start).toHaveBeenCalledWith({ gatewayId: GW, source: 'tenant', amount: '100.00' }, { lang: 'fa', accessToken: 'access-1', platform: 'telegram' });
    const pay = (result.view.actions ?? []).flat().find((a) => a.kind === 'url');
    expect(pay?.url).toBe('https://pay.example/StartPay/A1');
    // Started is a commitment billing holds now (ADR-0010): nothing here may start it twice.
    expect(result.nextState).toBeNull();
  });

  it('hands an in-chat gateway’s invoice to the dispatcher instead of a URL, and never says credited (F-104-m)', async () => {
    const { flow } = harness({
      billing: {
        start: vi.fn().mockResolvedValue(
          ok({ paymentId: 'p-3', free: false, redirectUrl: null, invoice: { payload: 'p-3', currency: 'XTR', amountMinor: '770' }, amount: '10.00', discount: '0.00', fee: '0.00', payable: '10.00', credited: '10.00', balance: null }),
        ),
      },
    });

    const result = await flow.handle(ctx, onConfirm, 'topup:pay');

    expect(result.view.id).toBe('topUp.payInChat');
    expect(result.invoice).toMatchObject({ payload: 'p-3', currency: 'XTR', amount: 770, description: { values: { credited: '10.00' } } });
    expect(result.nextState).toBeNull();
  });

  it('says the wallet was credited on a free top-up, with nowhere to send the user', async () => {
    const { flow } = harness({
      billing: {
        start: vi.fn().mockResolvedValue(ok({ paymentId: 'p-2', free: true, redirectUrl: null, amount: '100.00', discount: '100.00', fee: '0.00', payable: '0.00', credited: '100.00', balance: '250.00' })),
      },
    });

    const result = await flow.handle(ctx, onConfirm, 'topup:pay');

    expect(result.view).toMatchObject({ id: 'topUp.credited', body: { values: { credited: '100.00', balance: '250.00' } } });
    expect(result.nextState).toBeNull();
  });

  it('ends the conversation on a refused start, saying billing’s own sentence', async () => {
    const { flow } = harness({ billing: { start: vi.fn().mockResolvedValue(refused('درگاه در دسترس نیست')) } });

    const result = await flow.handle(ctx, onConfirm, 'topup:pay');

    expect(result.view.body).toEqual({ raw: 'درگاه در دسترس نیست' });
    expect(result.nextState).toBeNull();
  });

  it('asks a chat whose session died to sign in, and calls billing for nothing', async () => {
    const { flow, billing } = harness({ session: null });

    const result = await flow.start(ctx);

    expect(result.view.id).toBe('topUp.signedOut');
    expect(billing.listGateways).not.toHaveBeenCalled();
  });
});
