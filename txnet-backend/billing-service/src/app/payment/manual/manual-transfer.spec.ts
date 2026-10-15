/**
 * Starting a manual top-up (F-803-d, contract.manual-transfer.md "Starting
 * one"): a manual gateway charges in its destination's currency, not a
 * driver's; the payer is shown the public fields of the first active
 * destination, the exact charge and a window; the payment's clock is that
 * window plus a day's grace for a late proof; and the deposit list answers
 * gateways that settle themselves first.
 */
import { GatewayFailure, type PaymentProvider } from '../gateway/payment-provider';
import { ManualTransferProvider } from './manual-transfer.provider';
import { automaticFirst, chargeOf, isAutomatic, transferBody, transferPlanOf, transferWindow, TRANSFER_GRACE_MS } from './manual-transfer';

const CARD_FIELDS = { cardNumber: '6037991234567893', holderName: 'Sara Ahmadi', bankId: 'melli', sheba: 'IR820540102680020817909002' };
const WALLET_FIELDS = { asset: 'USDT', network: 'Tron (TRC20)', address: 'TQ5NqEdFHaRZXTDxWHxQFuZ3DtGVu8yXhR', decimals: 6 };

const setting = (kind: string, fields: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
  manualSetting: {
    kind,
    confirmationMode: 'manual_admin_required',
    requiredProof: ['trackingCode'],
    windowMinutes: 30,
    destinations: fields ? [{ id: 'dest-1', fields }] : [],
    ...over,
  },
});
const zarinpal = { chargeCurrency: 'IRR', chargeDecimals: 0 };

describe('what a manual gateway charges in', () => {
  it("is its destination's: a card in rials, a wallet in its asset at its decimals", () => {
    expect(chargeOf(setting('card_to_card', CARD_FIELDS), new ManualTransferProvider())).toEqual({ currency: 'IRR', decimals: 0 });
    expect(chargeOf(setting('crypto_wallet', WALLET_FIELDS), new ManualTransferProvider())).toEqual({ currency: 'USDT', decimals: 6 });
  });

  it("is the driver's for any other gateway", () => {
    expect(chargeOf({ manualSetting: null }, zarinpal)).toEqual({ currency: 'IRR', decimals: 0 });
  });

  it('is never a guess: the manual driver has no currency of its own, and asking it is a bug', () => {
    expect(() => new ManualTransferProvider().chargeCurrency).toThrow(/destination/);
    expect(() => chargeOf(setting('card_to_card', null), new ManualTransferProvider())).toThrow(/destination/);
  });
});

describe('the manual driver', () => {
  it('settles by a person, mints nothing and lists nothing a reconciliation run could ask about', async () => {
    const driver = new ManualTransferProvider();
    expect(driver.settlement).toBe('manual');
    // Through the port: a driver without the list is one reconciliation does not ask (F-092-ad).
    expect((driver as PaymentProvider).listUnverified).toBeUndefined();
    await expect(driver.request()).rejects.toBeInstanceOf(GatewayFailure);
    await expect(driver.verify()).rejects.toBeInstanceOf(GatewayFailure);
  });
});

describe('the transfer a start answers', () => {
  const now = new Date('2026-10-15T10:00:00Z');

  it('is the first active destination, or none for a gateway with nothing to pay into', () => {
    expect(transferPlanOf(setting('card_to_card', CARD_FIELDS))?.destinationId).toBe('dest-1');
    expect(transferPlanOf(setting('card_to_card', null))).toBeNull();
    expect(transferPlanOf({ manualSetting: null })).toBeNull();
  });

  it("runs the gateway's window, and the payment's clock a day of grace past it", () => {
    const plan = transferPlanOf(setting('card_to_card', CARD_FIELDS, { windowMinutes: 45 }));
    if (!plan) throw new Error('no plan');
    const { windowEndsAt, expiresAt } = transferWindow(plan, now);
    expect(windowEndsAt).toEqual(new Date('2026-10-15T10:45:00Z'));
    expect(expiresAt.getTime() - windowEndsAt.getTime()).toBe(TRANSFER_GRACE_MS);
    expect(TRANSFER_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('shows the public fields, the exact charge, and what the payer must send', () => {
    const plan = transferPlanOf(setting('card_to_card', CARD_FIELDS));
    if (!plan) throw new Error('no plan');
    const windowEndsAt = new Date('2026-10-15T10:30:00Z');
    expect(transferBody(plan, { currency: 'IRR', decimals: 0 }, BigInt(12_345_670), windowEndsAt)).toEqual({
      kind: 'card_to_card',
      // Through `publicDestination`: the kind says which fields a payer sees (F-803-b).
      destination: CARD_FIELDS,
      amountMinor: '12345670',
      currencyCode: 'IRR',
      decimals: 0,
      windowEndsAt,
      requiredProof: ['trackingCode'],
      confirmationMode: 'manual_admin_required',
    });
  });
});

describe('the deposit list', () => {
  it('answers gateways that settle themselves first, each group in its own order', () => {
    const rows = [
      { id: 'card', ...setting('card_to_card', CARD_FIELDS) },
      { id: 'zarinpal', manualSetting: null },
      { id: 'wallet', ...setting('crypto_wallet', WALLET_FIELDS) },
      { id: 'stripe', manualSetting: null },
    ];
    expect(automaticFirst(rows).map((g) => g.id)).toEqual(['zarinpal', 'stripe', 'card', 'wallet']);
  });

  it('counts a manual gateway as confirmed by a person until a watcher exists (principle 7)', () => {
    expect(isAutomatic({ manualSetting: null })).toBe(true);
    expect(isAutomatic(setting('card_to_card', CARD_FIELDS))).toBe(false);
  });
});
