/**
 * Writing a payment gateway's secrets (F-102-a, D-31).
 *
 * `billing-service` loads the vault read-only (ADR-0039), so the gateway
 * management surface hands the merchant id and secret key to this service over
 * the internal seam and never stores them itself. The invariant this turns on
 * is **where** the value lands and **what comes back**, because both break
 * silently:
 *
 *  - the vault a secret lands in is re-derived from the gateway row, never
 *    taken from the caller. A body naming tenant A with tenant B's gateway id
 *    would otherwise put A's merchant account behind B's gateway — every payment
 *    through it paid into somebody else's account, with nothing red anywhere;
 *  - a platform gateway's secrets belong to the platform owner's vault alone;
 *  - the answer says *configured or not* and nothing else: no plaintext, no
 *    fingerprint (ADR-0026 guarantee 1). A refusal does not echo the value
 *    either, because a refusal is what ends up in a log.
 */
import { TenantCredentialKind, TenantCredentialStatus, TenantType } from '@prisma/client';

import { GatewayCredentialRefused, GatewayCredentialService } from './gateway-credential.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const PLATFORM_GATEWAY = '44444444-4444-4444-8444-444444444444';
const RESELLER_GATEWAY = '55555555-5555-4555-8555-555555555555';
const ACTOR = '66666666-6666-4666-8666-666666666666';

const MERCHANT = 'zp-merchant-9f3c1e';
const SECRET = 'sk_live_very_secret_value';
const WEBHOOK = 'whsec_signing_secret_value';

type Stored = { kind: TenantCredentialKind; label: string; tenantId: string; plaintext: string; version: number; revoked: boolean; createdBy?: string };

function build() {
  const stored: Stored[] = [];
  const key = (r: { tenantId: string; kind: TenantCredentialKind; label?: string }) =>
    stored.find((s) => s.tenantId === r.tenantId && s.kind === r.kind && s.label === (r.label ?? '') && !s.revoked);
  const summarize = (s: Stored) => ({
    kind: s.kind,
    label: s.label,
    configured: true,
    fingerprint: 'fp-' + s.plaintext,
    status: TenantCredentialStatus.active,
    version: s.version,
    lastUsedAt: null,
    expiresAt: null,
    rotatedAt: new Date('2026-09-13T10:00:00Z'),
  });

  const vault = {
    put: vi.fn(async (ref: { tenantId: string; kind: TenantCredentialKind; label?: string }, plaintext: string, options: { createdBy?: string } = {}) => {
      const current = key(ref);
      if (current) current.revoked = true;
      const row: Stored = { ...ref, label: ref.label ?? '', plaintext, version: (current?.version ?? 0) + 1, revoked: false, createdBy: options.createdBy };
      stored.push(row);
      return summarize(row);
    }),
    summary: vi.fn(async (ref: { tenantId: string; kind: TenantCredentialKind; label?: string }) => {
      const row = key(ref);
      return row ? summarize(row) : null;
    }),
    revoke: vi.fn(async (ref: { tenantId: string; kind: TenantCredentialKind; label?: string }) => {
      const row = key(ref);
      if (row) row.revoked = true;
    }),
  };

  const prisma = {
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const types: Record<string, TenantType> = { [OWNER]: TenantType.platform_owner, [RESELLER]: TenantType.reseller, [OTHER]: TenantType.reseller };
        return types[where.id] ? { tenantType: types[where.id] } : null;
      }),
    },
    paymentGateway: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === PLATFORM_GATEWAY ? { id: PLATFORM_GATEWAY } : null)),
    },
    tenantGatewayConfig: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === RESELLER_GATEWAY ? { id: RESELLER_GATEWAY, tenantId: RESELLER } : null,
      ),
    },
  };

  const service = new GatewayCredentialService(vault as never, prisma as never);
  return { service, vault, stored };
}

async function refusal(run: () => Promise<unknown>): Promise<GatewayCredentialRefused> {
  try {
    await run();
  } catch (e) {
    if (e instanceof GatewayCredentialRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('GatewayCredentialService', () => {
  it("stores a tenant gateway's secrets in that tenant's vault, labelled with the gateway row", async () => {
    const { service, stored } = build();

    await service.set(
      { tenantId: RESELLER, source: 'tenant', gatewayId: RESELLER_GATEWAY },
      { merchantId: MERCHANT, secretKey: SECRET },
      ACTOR,
    );

    expect(stored).toEqual([
      expect.objectContaining({ tenantId: RESELLER, kind: TenantCredentialKind.gateway_merchant_id, label: `gateway:tenant:${RESELLER_GATEWAY}`, plaintext: MERCHANT, createdBy: ACTOR }),
      expect.objectContaining({ tenantId: RESELLER, kind: TenantCredentialKind.gateway_secret_key, label: `gateway:tenant:${RESELLER_GATEWAY}`, plaintext: SECRET, createdBy: ACTOR }),
    ]);
  });

  it("stores a platform gateway's secrets in the platform owner's vault", async () => {
    const { service, stored } = build();

    await service.set({ tenantId: OWNER, source: 'platform', gatewayId: PLATFORM_GATEWAY }, { merchantId: MERCHANT }, ACTOR);

    expect(stored).toEqual([
      expect.objectContaining({ tenantId: OWNER, kind: TenantCredentialKind.gateway_merchant_id, label: `gateway:platform:${PLATFORM_GATEWAY}` }),
    ]);
  });

  it('answers whether each secret is configured, and never the value or its fingerprint', async () => {
    const { service } = build();

    const state = await service.set(
      { tenantId: RESELLER, source: 'tenant', gatewayId: RESELLER_GATEWAY },
      { merchantId: MERCHANT },
      ACTOR,
    );

    expect(state).toEqual({
      merchantId: { configured: true, version: 1, rotatedAt: expect.any(Date) },
      secretKey: { configured: false, version: null, rotatedAt: null },
      webhookSecret: { configured: false, version: null, rotatedAt: null },
    });
    const wire = JSON.stringify(state);
    expect(wire).not.toContain(MERCHANT);
    expect(wire).not.toContain('fp-');
  });

  it("stores a webhook signing secret beside the other two, under kind webhook_secret and the same label (F-104-c)", async () => {
    const { service, stored } = build();

    const state = await service.set(
      { tenantId: RESELLER, source: 'tenant', gatewayId: RESELLER_GATEWAY },
      { webhookSecret: WEBHOOK },
      ACTOR,
    );

    expect(stored).toEqual([
      expect.objectContaining({ tenantId: RESELLER, kind: TenantCredentialKind.webhook_secret, label: `gateway:tenant:${RESELLER_GATEWAY}`, plaintext: WEBHOOK }),
    ]);
    expect(state.webhookSecret).toEqual({ configured: true, version: 1, rotatedAt: expect.any(Date) });
    expect(JSON.stringify(state)).not.toContain(WEBHOOK);
  });

  it('refuses a tenant gateway that belongs to a different tenant than the one named, and writes nothing', async () => {
    const { service, vault } = build();

    const e = await refusal(() =>
      service.set({ tenantId: OTHER, source: 'tenant', gatewayId: RESELLER_GATEWAY }, { merchantId: MERCHANT }, ACTOR),
    );

    expect(e.reason).toBe('not_owner');
    expect(vault.put).not.toHaveBeenCalled();
  });

  it('refuses a platform gateway named with any tenant but the platform owner', async () => {
    const { service, vault } = build();

    const e = await refusal(() =>
      service.set({ tenantId: RESELLER, source: 'platform', gatewayId: PLATFORM_GATEWAY }, { merchantId: MERCHANT }, ACTOR),
    );

    expect(e.reason).toBe('not_owner');
    expect(vault.put).not.toHaveBeenCalled();
  });

  it('refuses a gateway that does not exist', async () => {
    const { service } = build();

    const e = await refusal(() =>
      service.set({ tenantId: RESELLER, source: 'tenant', gatewayId: PLATFORM_GATEWAY }, { merchantId: MERCHANT }, ACTOR),
    );

    expect(e.reason).toBe('gateway_not_found');
  });

  it('trims a pasted value, refuses a blank one, and never repeats the value in a refusal', async () => {
    const { service, stored } = build();
    const target = { tenantId: RESELLER, source: 'tenant' as const, gatewayId: RESELLER_GATEWAY };

    await service.set(target, { merchantId: `  ${MERCHANT}\n` }, ACTOR);
    expect(stored[0].plaintext).toBe(MERCHANT);

    const blank = await refusal(() => service.set(target, { secretKey: '   ' }, ACTOR));
    expect(blank.reason).toBe('empty_value');

    const none = await refusal(() => service.set(target, {}, ACTOR));
    expect(none.reason).toBe('nothing_to_set');

    const refusedWithValue = await refusal(() =>
      service.set({ ...target, tenantId: OTHER }, { merchantId: MERCHANT }, ACTOR),
    );
    expect(refusedWithValue.message).not.toContain(MERCHANT);
  });

  it("revokes every one of a gateway's secrets, and the state then says none is configured", async () => {
    const { service, vault } = build();
    const target = { tenantId: RESELLER, source: 'tenant' as const, gatewayId: RESELLER_GATEWAY };
    await service.set(target, { merchantId: MERCHANT, secretKey: SECRET, webhookSecret: WEBHOOK }, ACTOR);

    const state = await service.revoke(target);

    expect(vault.revoke).toHaveBeenCalledTimes(3);
    expect(state.merchantId.configured).toBe(false);
    expect(state.secretKey.configured).toBe(false);
    expect(state.webhookSecret.configured).toBe(false);
  });
});
