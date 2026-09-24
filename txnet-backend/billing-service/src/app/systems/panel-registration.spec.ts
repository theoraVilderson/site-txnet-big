/**
 * Registering a panel (F-027-ar, ADR-0080 decision 1): the route writes the
 * `panel` row as `pending` and nothing tests it — `network-service` does, on
 * its own tick. What would break silently here:
 *
 *  - **who.** The platform owner registers, nobody else (decision 2): a
 *    reseller's panel would have the cross-tenant collector dial an address a
 *    tenant chose. The refusal writes nothing and calls no vault;
 *  - **the secret.** The panel's login goes to the owner's vault and never
 *    into `panel.panelApiCredentials`, which holds only where the vault keeps
 *    it — a column is read by every `select *`, a vault row by one audited
 *    `use`;
 *  - **no half-registration.** A vault that refused or did not answer leaves
 *    no `pending` row behind: the next tick would test a panel whose
 *    credentials were never stored.
 */
import { DriverType, CounterSemantics, PanelTransport, PanelRole, TenantType } from '@prisma/client';
import { panelCredentialLabel, panelCredentialRef } from '@txnet-backend/shared-core';

import { PanelCredentialWriter, PanelRegistrationService } from './panel-registration';
import { PanelScopeRefused } from './panel-scope';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SECRET = '{"username":"root","password":"hunter2-panel"}';

const INPUT = {
  name: 'de-fra-1',
  ipAddress: '203.0.113.7',
  apiBaseUrl: 'https://panel.example.net:8443',
  driverType: DriverType.marzban,
  counterSemantics: CounterSemantics.cumulative,
  transport: PanelTransport.pull,
  role: PanelRole.active,
  region: 'eu-central',
  credentials: SECRET,
};

function harness(opts: { vaultFails?: boolean } = {}) {
  const panels: Array<Record<string, unknown>> = [];
  const tenants = new Map([
    [OWNER, TenantType.platform_owner],
    [RESELLER, TenantType.reseller],
  ]);
  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        tenants.has(where.id) ? { tenantType: tenants.get(where.id) } : null,
    },
    panel: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        panels.push({ ...data });
        return data;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = panels.findIndex((p) => p['id'] === where.id);
        panels.splice(i, 1);
      },
    },
  };
  const written: Array<{ tenantId: string; panelId: string; credentials: string; actorId: string }> = [];
  const vault: PanelCredentialWriter = {
    set: async (target, credentials, actorId) => {
      if (opts.vaultFails) throw new Error('tenant-service did not answer');
      written.push({ ...target, credentials, actorId });
      return { configured: true, version: 1, rotatedAt: '2026-09-24T10:00:00.000Z' };
    },
  };
  const service = new PanelRegistrationService(prisma as never, vault);
  return { service, panels, written };
}

describe('PanelRegistrationService.register', () => {
  it('refuses a tenant that is not the platform owner, before anything is written', async () => {
    const { service, panels, written } = harness();

    await expect(service.register({ adminId: ADMIN, tenantId: RESELLER }, INPUT)).rejects.toMatchObject({
      reason: 'not_platform_owner',
    });
    await expect(service.register({ adminId: ADMIN, tenantId: RESELLER }, INPUT)).rejects.toBeInstanceOf(
      PanelScopeRefused,
    );
    expect(panels).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it('writes a pending platform panel whose credential column names the vault, never the secret', async () => {
    const { service, panels, written } = harness();

    const answer = await service.register({ adminId: ADMIN, tenantId: OWNER }, INPUT);

    expect(panels).toHaveLength(1);
    const row = panels[0];
    expect(row).toMatchObject({
      ownershipType: 'platform',
      tenantId: null,
      reviewState: 'pending',
      driverType: DriverType.marzban,
      apiBaseUrl: INPUT.apiBaseUrl,
    });
    expect(row['panelApiCredentials']).toBe(panelCredentialRef(OWNER, row['id'] as string));
    expect(JSON.stringify(row)).not.toContain('hunter2');

    // The owner's vault, under the panel's own label, with who did it.
    expect(written).toEqual([{ tenantId: OWNER, panelId: row['id'], credentials: SECRET, actorId: ADMIN }]);
    expect(panelCredentialRef(OWNER, row['id'] as string)).toContain(panelCredentialLabel(row['id'] as string));

    expect(answer).toEqual({
      id: row['id'],
      reviewState: 'pending',
      credentials: { configured: true, version: 1, rotatedAt: '2026-09-24T10:00:00.000Z' },
    });
    expect(JSON.stringify(answer)).not.toContain('hunter2');
  });

  it('leaves no pending panel behind when the vault write fails', async () => {
    const { service, panels } = harness({ vaultFails: true });

    await expect(service.register({ adminId: ADMIN, tenantId: OWNER }, INPUT)).rejects.toThrow();
    expect(panels).toHaveLength(0);
  });
});
