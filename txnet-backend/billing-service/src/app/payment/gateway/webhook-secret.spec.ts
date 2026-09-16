/**
 * Serving a gateway's webhook signing secret to `verifyWebhook` (F-104-c).
 *
 * The door F-104-b built answers 401 whenever this answers `null`, so the two
 * ways this goes wrong are both silent:
 *  - reading the wrong credential — the merchant id, or another gateway's
 *    label — verifies every post against a value the provider never signed with;
 *  - throwing on a gateway with no secret turns a closed door into a 500 the
 *    provider retries for days. Missing or revoked is `null`, and only that.
 */
import { TenantCredentialKind } from '@prisma/client';
import { CredentialUnavailable } from '@txnet-backend/shared-core';

import { GatewayMerchant, hasEverySecret, type MerchantGatewayRef } from './gateway-merchant';
import { WebhookSecretSource } from './webhook-secret';

const OWNER = '11111111-1111-4111-8111-111111111111';
const GATEWAY = '55555555-5555-4555-8555-555555555555';

const gateway: MerchantGatewayRef = { tenantId: OWNER, source: 'tenant', gatewayId: GATEWAY, providerName: 'stripe' };

function build(stored: string | null) {
  const vault = {
    use: vi.fn(async (ref: { tenantId: string; kind: TenantCredentialKind; label: string }) => {
      if (stored === null) throw new CredentialUnavailable(ref, 'missing');
      return stored;
    }),
  };
  const merchant = new GatewayMerchant(vault as never, {} as never);
  return { source: new WebhookSecretSource(merchant), vault };
}

describe('WebhookSecretSource', () => {
  it("answers the gateway's webhook_secret, read under that gateway row's label and audited as a use", async () => {
    const { source, vault } = build('whsec_abc');

    await expect(source.secretFor(gateway)).resolves.toBe('whsec_abc');

    expect(vault.use).toHaveBeenCalledWith(
      { tenantId: OWNER, kind: TenantCredentialKind.webhook_secret, label: `gateway:tenant:${GATEWAY}` },
      { caller: 'billing:stripe', actorId: null },
    );
  });

  it('answers null for a gateway with no webhook secret, so the door is a 401 and not a 500', async () => {
    const { source } = build(null);

    await expect(source.secretFor(gateway)).resolves.toBeNull();
  });

  it('lets any other vault failure through', async () => {
    const vault = { use: vi.fn(async () => { throw new Error('decrypt failed'); }) };
    const source = new WebhookSecretSource(new GatewayMerchant(vault as never, {} as never));

    await expect(source.secretFor(gateway)).rejects.toThrow('decrypt failed');
  });
});

/**
 * Each provider's own secrets (F-104-g). Until Stripe, a gateway was "a merchant
 * id": the payment read only that, and the top-up page kept only a gateway that
 * had one. A Stripe gateway has none, so it would have been hidden for ever and
 * charged with nothing. What decides now is `provider-fields.ts`.
 */
describe('GatewayMerchant — the secrets a provider declares', () => {
  it('hands a Stripe payment its secret key, and neither a merchant id nor the webhook secret', async () => {
    const { vault } = build('sk_test_1');
    const merchant = new GatewayMerchant(vault as never, {} as never);

    await expect(merchant.credentialsFor(gateway, 'actor-1')).resolves.toEqual({ secretKey: 'sk_test_1' });
    expect(vault.use).toHaveBeenCalledTimes(1);
    expect(vault.use).toHaveBeenCalledWith(
      { tenantId: OWNER, kind: TenantCredentialKind.gateway_secret_key, label: `gateway:tenant:${GATEWAY}` },
      { caller: 'billing:stripe', actorId: 'actor-1' },
    );
  });

  it('still hands Zarinpal its merchant id alone', async () => {
    const { vault } = build('zp-merchant');
    const merchant = new GatewayMerchant(vault as never, {} as never);

    await expect(merchant.credentialsFor({ ...gateway, providerName: 'zarinpal' })).resolves.toEqual({ merchantId: 'zp-merchant' });
    expect(vault.use.mock.calls[0][0].kind).toBe(TenantCredentialKind.gateway_merchant_id);
  });

  it('keeps a gateway on the top-up page only when every secret its provider declares is stored', () => {
    const label = `gateway:tenant:${GATEWAY}`;
    const held = (...names: Array<'merchantId' | 'secretKey' | 'webhookSecret'>) => new Map([[label, new Set(names)]]);
    const stripe = { source: 'tenant' as const, gatewayId: GATEWAY, providerName: 'stripe' as const };

    expect(hasEverySecret(held('merchantId'), stripe)).toBe(false);
    expect(hasEverySecret(held('secretKey'), stripe)).toBe(false);
    expect(hasEverySecret(held('secretKey', 'webhookSecret'), stripe)).toBe(true);
    expect(hasEverySecret(held('merchantId'), { ...stripe, providerName: 'zarinpal' })).toBe(true);
    expect(hasEverySecret(undefined, { ...stripe, providerName: 'zarinpal' })).toBe(false);
  });

  it('refuses a manual-fee Stripe payment whose webhook secret is missing, without decrypting anything', async () => {
    const summaries: Record<string, { configured: boolean; status: string } | null> = {
      [TenantCredentialKind.gateway_secret_key]: { configured: true, status: 'active' },
      [TenantCredentialKind.webhook_secret]: null,
    };
    const vault = { use: vi.fn(), summary: vi.fn(async (ref: { kind: string }) => summaries[ref.kind] ?? null) };
    const merchant = new GatewayMerchant(vault as never, {} as never);

    await expect(merchant.requireConfigured(gateway)).rejects.toBeInstanceOf(CredentialUnavailable);
    expect(vault.use).not.toHaveBeenCalled();
  });
});
