import { createHmac } from 'node:crypto';

import { NowPaymentsProvider } from './nowpayments.provider';

/**
 * F-104-aa — a NOWPayments IPN's crypto amounts reach `Decimal` as the digits
 * the body carried, not through an IEEE-754 double.
 *
 * `JSON.parse` turns `"actually_paid": 0.493827156049382732` into a double, and
 * an 18-decimal asset loses everything past ~17 significant digits. That is
 * enough to move `price_amount × actually_paid / pay_amount`, which
 * `receivedCents` floors (`ROUND_DOWN`), by one cent — so a `partially_paid`
 * receipt credits a cent less than arrived.
 *
 * The vector below is that boundary: 40% of a $12.50 invoice, which is exactly
 * 500 cents on the digits sent and 499 through the double.
 *
 * The signature is unaffected and must stay so: NOWPayments' own Node example
 * signs the body re-serialized from `JSON.parse`, so the sort still prints the
 * numbers as doubles. Only what `decimalOf` reads changes.
 */

const IPN_SECRET = 'ipn_secret_do_not_log';

/** The docs' webhook example, with the amount fields replaced verbatim. */
function rawIpn(fields: Record<string, string>): string {
  const body: Record<string, string> = {
    payment_id: '123456789',
    invoice_id: '4522625843',
    payment_status: '"partially_paid"',
    price_amount: '12.5',
    price_currency: '"usd"',
    pay_amount: '1.23456789012345683',
    actually_paid: '0.493827156049382732',
    pay_currency: '"eth"',
    ...fields,
  };
  return `{${Object.entries(body)
    .map(([k, v]) => `"${k}": ${v}`)
    .join(', ')}}`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** Signed the way NOWPayments' own example signs — over the parsed body, key-sorted. */
function ipn(fields: Record<string, string> = {}) {
  const raw = rawIpn(fields);
  const sig = createHmac('sha512', IPN_SECRET).update(JSON.stringify(sorted(JSON.parse(raw)))).digest('hex');
  return { rawBody: Buffer.from(raw), headers: { 'x-nowpayments-sig': sig }, secret: IPN_SECRET };
}

const provider = new NowPaymentsProvider({ sandbox: false });

describe('NowPaymentsProvider.verifyWebhook — the amounts, exactly as sent', () => {
  it('credits a partial payment on the digits the body carried, not the double', () => {
    expect(provider.verifyWebhook(ipn())).toEqual({
      kind: 'paid',
      authority: '4522625843',
      referenceId: '123456789',
      received: { amountMinor: BigInt(500), currency: 'USD' },
    });
  });

  it('still reads a numeric string, and an amount nested elsewhere is not one of these', () => {
    const event = provider.verifyWebhook(
      ipn({ actually_paid: '"0.493827156049382732"', fee: '{"currency": "eth", "pay_amount": 0.1}' }),
    );
    expect(event).toMatchObject({ received: { amountMinor: BigInt(500), currency: 'USD' } });
  });

  it('keeps the signature over the body as JSON.parse built it', () => {
    const signed = ipn();
    const tampered = { ...signed, rawBody: Buffer.from(rawIpn({ actually_paid: '0.593827156049382732' })) };
    expect(() => provider.verifyWebhook(tampered)).toThrow(/signature does not match/);
  });
});
