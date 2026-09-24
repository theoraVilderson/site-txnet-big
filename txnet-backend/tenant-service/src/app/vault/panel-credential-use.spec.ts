/**
 * Reading a panel's login back out, for `network-service`'s Opener (F-027-aw).
 *
 * The collector is Go and the vault is Node, with a data key per tenant, so Go
 * asks this route rather than holding the KEK (user, 2026-09-24). The
 * invariant is the one `set` holds, read in the other direction: **the vault
 * a login is read from is the panel owner's, re-derived, never the one a row
 * or a caller names.** `panelApiCredentials` is a reference, and a reference
 * edited to name another tenant's vault would sign the collector in to a
 * server with somebody else's login — the SSRF ADR-0080 decision 2 keeps
 * closed. And a refusal never carries the value, because a refusal is what
 * ends up in a log.
 */
import { PanelOwnershipType, TenantCredentialKind, TenantType } from '@prisma/client';
import { CredentialUnavailable, panelCredentialRef, panelRadiusSecretRef } from '@txnet-backend/shared-core';

import { PanelCredentialRefused, PanelCredentialService } from './panel-credential.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const PLATFORM_PANEL = '44444444-4444-4444-8444-444444444444';
const RESELLER_PANEL = '55555555-5555-4555-8555-555555555555';
const TAMPERED_PANEL = '66666666-6666-4666-8666-666666666666';
const BARE_PANEL = '77777777-7777-4777-8777-777777777777';
const NAS_PANEL = '99999999-9999-4999-8999-999999999999';
const TAMPERED_NAS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const LOGIN = 'admin:hunter2-very-secret';
const RADIUS_SECRET = 'nas-shared-hunter3';

type Ref = { tenantId: string; kind: TenantCredentialKind; label?: string };

function build() {
  const logins = new Map<string, string>([
    [`${OWNER}/panel:${PLATFORM_PANEL}`, LOGIN],
    [`${RESELLER}/panel:${RESELLER_PANEL}`, LOGIN],
    [`${OTHER}/panel:${TAMPERED_PANEL}`, LOGIN],
    [`${RESELLER}/panel:${NAS_PANEL}`, LOGIN],
    [`${RESELLER}/panel:${NAS_PANEL}:radius`, RADIUS_SECRET],
    [`${OTHER}/panel:${TAMPERED_NAS}:radius`, RADIUS_SECRET],
  ]);
  const vault = {
    use: vi.fn(async (ref: Ref, _access: { caller: string }) => {
      const value = logins.get(`${ref.tenantId}/${ref.label}`);
      if (value === undefined) throw new CredentialUnavailable(ref, 'missing');
      return value;
    }),
  };
  type Row = { ownershipType: PanelOwnershipType; tenantId: string | null; panelApiCredentials: string; panelRadiusSecret?: string | null };
  const panels: Record<string, Row> = {
    [PLATFORM_PANEL]: { ownershipType: PanelOwnershipType.platform, tenantId: null, panelApiCredentials: panelCredentialRef(OWNER, PLATFORM_PANEL) },
    [RESELLER_PANEL]: { ownershipType: PanelOwnershipType.tenant, tenantId: RESELLER, panelApiCredentials: panelCredentialRef(RESELLER, RESELLER_PANEL) },
    // A reseller's panel whose reference was edited to name another vault.
    [TAMPERED_PANEL]: { ownershipType: PanelOwnershipType.tenant, tenantId: RESELLER, panelApiCredentials: panelCredentialRef(OTHER, TAMPERED_PANEL) },
    // A row holding something that is not a reference at all.
    [BARE_PANEL]: { ownershipType: PanelOwnershipType.tenant, tenantId: RESELLER, panelApiCredentials: LOGIN },
    // A push panel: a REST login and a NAS secret, two references (F-027-az).
    [NAS_PANEL]: {
      ownershipType: PanelOwnershipType.tenant,
      tenantId: RESELLER,
      panelApiCredentials: panelCredentialRef(RESELLER, NAS_PANEL),
      panelRadiusSecret: panelRadiusSecretRef(RESELLER, NAS_PANEL),
    },
    // A push panel whose secret reference was edited to name another vault.
    [TAMPERED_NAS]: {
      ownershipType: PanelOwnershipType.tenant,
      tenantId: RESELLER,
      panelApiCredentials: panelCredentialRef(RESELLER, TAMPERED_NAS),
      panelRadiusSecret: panelRadiusSecretRef(OTHER, TAMPERED_NAS),
    },
  };
  const prisma = {
    panel: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => panels[where.id] ?? null) },
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const types: Record<string, TenantType> = { [OWNER]: TenantType.platform_owner, [RESELLER]: TenantType.reseller, [OTHER]: TenantType.reseller };
        return types[where.id] ? { tenantType: types[where.id] } : null;
      }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new PanelCredentialService(vault as any, prisma as any);
  return { service, vault };
}

async function refusal(p: Promise<unknown>): Promise<PanelCredentialRefused> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PanelCredentialRefused);
  expect(String((e as Error).message)).not.toContain('hunter');
  return e as PanelCredentialRefused;
}

describe('PanelCredentialService.use (F-027-aw)', () => {
  it("reads a reseller panel's login from that reseller's vault, named as the Opener", async () => {
    const { service, vault } = build();
    await expect(service.use(RESELLER_PANEL)).resolves.toBe(LOGIN);
    expect(vault.use).toHaveBeenCalledWith(
      { tenantId: RESELLER, kind: TenantCredentialKind.panel_credentials, label: `panel:${RESELLER_PANEL}` },
      { caller: 'network:Opener' },
    );
  });

  it("reads a platform panel's login from the platform owner's vault", async () => {
    const { service } = build();
    await expect(service.use(PLATFORM_PANEL)).resolves.toBe(LOGIN);
  });

  it('refuses a reference naming a vault that is not the owner’s, before the vault is opened', async () => {
    const { service, vault } = build();
    expect((await refusal(service.use(TAMPERED_PANEL))).reason).toBe('not_owner');
    expect(vault.use).not.toHaveBeenCalled();
  });

  it('refuses a row that holds no reference, without echoing what it holds', async () => {
    const { service, vault } = build();
    expect((await refusal(service.use(BARE_PANEL))).reason).toBe('credential_unavailable');
    expect(vault.use).not.toHaveBeenCalled();
  });

  it('answers an unknown panel as not found', async () => {
    const { service } = build();
    expect((await refusal(service.use('88888888-8888-4888-8888-888888888888'))).reason).toBe('panel_not_found');
  });

  it('turns a login the vault no longer has into a refusal, not a 500', async () => {
    const { service, vault } = build();
    vault.use.mockRejectedValueOnce(new CredentialUnavailable({ tenantId: RESELLER, kind: TenantCredentialKind.panel_credentials }, 'revoked'));
    expect((await refusal(service.use(RESELLER_PANEL))).reason).toBe('credential_unavailable');
  });
});

/**
 * A push panel's RADIUS secret (F-027-az). One vault login cannot be both the
 * router's REST login and the NAS's shared secret, so the secret has its own
 * reference and its own label. The failure this guards is quiet: a secret
 * read that falls back to the login signs the allowlist with a value no NAS
 * holds, and every packet is discarded as forged.
 */
describe("PanelCredentialService.use('radius_secret') (F-027-az)", () => {
  it('reads the secret under its own label, named as the RADIUS directory, never the login', async () => {
    const { service, vault } = build();
    await expect(service.use(NAS_PANEL, 'radius_secret')).resolves.toBe(RADIUS_SECRET);
    expect(vault.use).toHaveBeenCalledWith(
      { tenantId: RESELLER, kind: TenantCredentialKind.panel_credentials, label: `panel:${NAS_PANEL}:radius` },
      { caller: 'network:RadiusDirectory' },
    );
    await expect(service.use(NAS_PANEL)).resolves.toBe(LOGIN);
  });

  it('refuses a panel that holds no secret reference, and never answers the login in its place', async () => {
    const { service, vault } = build();
    expect((await refusal(service.use(RESELLER_PANEL, 'radius_secret'))).reason).toBe('credential_unavailable');
    expect(vault.use).not.toHaveBeenCalled();
  });

  it('refuses a secret reference naming a vault that is not the owner’s', async () => {
    const { service, vault } = build();
    expect((await refusal(service.use(TAMPERED_NAS, 'radius_secret'))).reason).toBe('not_owner');
    expect(vault.use).not.toHaveBeenCalled();
  });
});
