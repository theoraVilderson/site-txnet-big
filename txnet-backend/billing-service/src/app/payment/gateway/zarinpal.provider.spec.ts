import { GatewayFailure } from './payment-provider';
import { ZarinpalProvider } from './zarinpal.provider';

/**
 * The Zarinpal v4 driver (F-092-f).
 *
 * What earns this file its slot is the retry policy, because both ways it goes
 * wrong are silent and both cost money. Legacy retried everything and read
 * `101` as a failure, so a timeout after a verify that had already succeeded
 * marked a paid payment failed — the user was charged and credited nothing.
 * Retrying `request` is the mirror bug: every attempt mints a fresh authority,
 * so a timeout that had actually reached Zarinpal leaves a payable intent
 * nobody holds. A definite refusal retried is the third: the answer does not
 * change, and `-12` means Zarinpal is already counting.
 *
 * The fake is one `fetch` answering a queue of responses, so each test states
 * what the gateway said and asserts what the driver made of it.
 */
type Reply = { status?: number; body?: unknown } | Error;

const MERCHANT = 'merchant-5b3f-secret';
const credentials = { merchantId: MERCHANT };

function gateway(replies: Reply[], options: { sandbox?: boolean } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const reply = replies.shift();
    if (!reply) throw new Error('the fake gateway was called more often than the test expected');
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  const provider = new ZarinpalProvider({
    sandbox: options.sandbox ?? false,
    fetchImpl,
    sleep: async () => undefined,
  });
  return { provider, calls };
}

const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const refused = (code: number) => ({ status: 200, body: { data: [], errors: { code, message: 'x', validations: [] } } });

describe('ZarinpalProvider — request', () => {
  it('answers the StartPay URL of the host it asked, with the amount in rial', async () => {
    const { provider, calls } = gateway(
      [{ body: { data: { code: 100, authority: 'A0000000000000000000000000000123456' }, errors: [] } }],
      { sandbox: true },
    );

    const result = await provider.request({
      credentials,
      amountMinor: BigInt(1_250_000),
      callbackUrl: 'https://api.example.com/api/billing/payments/callback',
      description: 'wallet top-up',
    });

    expect(result).toEqual({
      authority: 'A0000000000000000000000000000123456',
      redirectUrl: 'https://sandbox.zarinpal.com/pg/StartPay/A0000000000000000000000000000123456',
    });
    expect(calls[0].url).toBe('https://sandbox.zarinpal.com/pg/v4/payment/request.json');
    expect(calls[0].body).toMatchObject({ amount: 1_250_000, currency: 'IRR', merchant_id: MERCHANT });
  });

  // `-9` is Zarinpal's "validation error", and only its message says which
  // field — a merchant id of the wrong shape, a callback it will not accept.
  // Without it the log reads "request refused" and nobody can act.
  it("keeps Zarinpal's validation detail for the log, with the merchant id redacted", async () => {
    const { provider } = gateway([
      {
        status: 422,
        body: {
          data: [],
          errors: {
            code: -9,
            message: 'The input params invalid, validation error.',
            validations: [{ merchant_id: `The merchant id ${MERCHANT} must be 36 characters.` }, { callback_url: 'The callback url format is invalid.' }],
          },
        },
      },
    ]);

    const failure = (await provider
      .request({ credentials, amountMinor: BigInt(22_802_500), callbackUrl: 'https://x.example/cb', description: 'top-up' })
      .catch((e: unknown) => e)) as GatewayFailure;

    expect(failure.reason).toBe('invalid_request');
    expect(failure.message).toContain('validation error');
    expect(failure.message).toContain('merchant_id: The merchant id [redacted] must be 36 characters.');
    expect(failure.message).toContain('callback_url: The callback url format is invalid.');
    expect(failure.message).not.toContain(MERCHANT);
  });

  it('is never retried, even when the failure was only a timeout', async () => {
    const { provider, calls } = gateway([timeout(), { body: { data: { code: 100, authority: 'A2' } } }]);

    const failure = await provider
      .request({ credentials, amountMinor: BigInt(10_000), callbackUrl: 'https://x', description: 'd' })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(GatewayFailure);
    expect(failure).toMatchObject({ reason: 'unavailable' });
    expect(calls).toHaveLength(1);
  });
});

describe('ZarinpalProvider — verify', () => {
  it('reads 101 (already verified) as success', async () => {
    const { provider } = gateway([{ body: { data: { code: 101, ref_id: 201, card_pan: '502229******5995' } } }]);

    await expect(provider.verify({ credentials, authority: 'A1', amountMinor: BigInt(10_000) })).resolves.toEqual({
      referenceId: '201',
      cardPan: '502229******5995',
      alreadyVerified: true,
    });
  });

  it('succeeds when a timeout hid a verify that had already landed', async () => {
    // The legacy bug on the row: attempt one reached Zarinpal and verified the
    // payment, the answer was lost, attempt two is told 101.
    const { provider, calls } = gateway([timeout(), { status: 502 }, { body: { data: { code: 101, ref_id: 7 } } }]);

    const result = await provider.verify({ credentials, authority: 'A1', amountMinor: BigInt(10_000) });

    expect(result).toMatchObject({ referenceId: '7', alreadyVerified: true });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a definite refusal', async () => {
    const { provider, calls } = gateway([refused(-51), { body: { data: { code: 100, ref_id: 1 } } }]);

    await expect(provider.verify({ credentials, authority: 'A1', amountMinor: BigInt(10_000) })).rejects.toMatchObject({
      reason: 'payment_failed',
      providerCode: '-51',
    });
    expect(calls).toHaveLength(1);
  });

  it('stops after its attempts and says the gateway was unavailable', async () => {
    const { provider, calls } = gateway([timeout(), timeout(), timeout()]);

    await expect(provider.verify({ credentials, authority: 'A1', amountMinor: BigInt(10_000) })).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(calls).toHaveLength(3);
  });

  it('never puts the merchant id in what it throws (billing invariant 8)', async () => {
    const { provider } = gateway([refused(-10)]);

    const failure = (await provider
      .verify({ credentials, authority: 'A1', amountMinor: BigInt(10_000) })
      .catch((e: unknown) => e)) as GatewayFailure;

    expect(failure.reason).toBe('merchant_rejected');
    expect(JSON.stringify({ ...failure, message: failure.message, stack: failure.stack })).not.toContain(MERCHANT);
  });
});

describe('ZarinpalProvider — inquiry and fee quote', () => {
  it('retries an inquiry past a 5xx and maps the status', async () => {
    const { provider } = gateway([{ status: 503 }, { body: { data: { code: 100, status: 'PAID' } } }]);

    await expect(provider.inquire({ credentials, authority: 'A1' })).resolves.toEqual({ status: 'paid' });
  });

  it('quotes the fee as the suggested amount above the one asked about', async () => {
    const { provider, calls } = gateway([{ body: { data: { code: 100, amount: 10_000, suggested_amount: 10_500 } } }]);

    await expect(provider.quoteFee({ credentials, amountMinor: BigInt(10_000) })).resolves.toEqual({ feeMinor: BigInt(500) });
    expect(calls[0].url).toBe('https://payment.zarinpal.com/pg/v4/payment/feeCalculation.json');
  });
});
