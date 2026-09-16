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

import { GatewayMerchant, type MerchantGatewayRef } from './gateway-merchant';
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
