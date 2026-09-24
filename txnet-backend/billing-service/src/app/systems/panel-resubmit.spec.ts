/**
 * Re-submitting a panel's login (F-027-au). The login is rotated in the vault
 * and, on a panel still `pending`, the last connection test is cleared so the
 * next tick tests the corrected login instead of waiting out a retry
 * (`network/contract.registration.md` rule 4). What would break silently:
 *
 *  - **an accepted panel sent back to `pending`.** Collection reads only an
 *    accepted panel (invariant 44), so a password change would stop billing.
 *    It is rotated, and its review is not touched;
 *  - **a cool-off skipped.** A `rate_limited` fault is not a bad login, and
 *    retrying through a ban is what makes it permanent: that fault keeps its
 *    time, and the retest waits as it would have;
 *  - **a refusal re-opened by the back door.** A refused panel was refused on
 *    its answers; a new login changes none of them, so it is 409 and nothing
 *    is written;
 *  - **half a rotation.** The row is changed only after the vault answered.
 */
import { ConnectionTestFault, PanelReviewState, TenantType } from '@prisma/client';

import { PanelCredentialWriter, PanelRegistrationService, PanelResubmitRefused } from './panel-registration';
import { resubmitCredentialsSchema } from './panel-registration.schema';
import { PanelScopeRefused } from './panel-scope';
import { SystemsRefused } from './systems-read';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = '55555555-5555-4555-8555-555555555555';
const TESTED = new Date('2026-09-24T09:00:00.000Z');
const LOGIN = 'root:new-password';

type Row = {
  id: string;
  ownershipType: string;
  tenantId: string | null;
  reviewState: PanelReviewState;
  connectionTestedAt: Date | null;
  connectionTestFault: ConnectionTestFault | null;
  connectionTestDetail: string | null;
};

function harness(row: Partial<Row> | null, opts: { vaultFails?: boolean; duringVault?: (panel: Row) => void } = {}) {
  const panel: Row | null = row && {
    id: PANEL,
    ownershipType: 'platform',
    tenantId: null,
    reviewState: PanelReviewState.pending,
    connectionTestedAt: TESTED,
    connectionTestFault: ConnectionTestFault.timeout,
    connectionTestDetail: 'dial tcp: i/o timeout',
    ...row,
  };
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === OWNER ? { tenantType: TenantType.platform_owner } : { tenantType: TenantType.reseller },
    },
    panel: {
      findFirst: async ({ where }: { where: { id: string; ownershipType: string; tenantId: null } }) =>
        panel && panel.id === where.id && panel.ownershipType === where.ownershipType && panel.tenantId === where.tenantId
          ? { reviewState: panel.reviewState, connectionTestFault: panel.connectionTestFault }
          : null,
      updateMany: async (args: { where: { id: string; reviewState: PanelReviewState }; data: Record<string, unknown> }) => {
        updates.push(args);
        if (!panel || panel.reviewState !== args.where.reviewState) return { count: 0 };
        Object.assign(panel, args.data);
        return { count: 1 };
      },
    },
  };
  const written: Array<{ tenantId: string; panelId: string; credentials: string; actorId: string }> = [];
  const vault: PanelCredentialWriter = {
    set: async (target, credentials, actorId) => {
      if (opts.vaultFails) throw new Error('tenant-service did not answer');
      if (panel && opts.duringVault) opts.duringVault(panel);
      written.push({ ...target, credentials, actorId });
      return { configured: true, version: 2, rotatedAt: '2026-09-24T10:00:00.000Z' };
    },
  };
  return { service: new PanelRegistrationService(prisma as never, vault), panel, updates, written };
}

const actor = { adminId: ADMIN, tenantId: OWNER };

describe('PanelRegistrationService.resubmitCredentials', () => {
  it('refuses a tenant that is not the platform owner, and writes nothing', async () => {
    const { service, written, updates } = harness({});
    await expect(service.resubmitCredentials({ adminId: ADMIN, tenantId: RESELLER }, PANEL, LOGIN)).rejects.toBeInstanceOf(
      PanelScopeRefused,
    );
    expect(written).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('is not_found for a panel outside the scope, the same as one that does not exist', async () => {
    for (const row of [null, { ownershipType: 'tenant', tenantId: RESELLER }]) {
      const { service, written } = harness(row);
      await expect(service.resubmitCredentials(actor, PANEL, LOGIN)).rejects.toMatchObject({ reason: 'not_found' });
      await expect(service.resubmitCredentials(actor, PANEL, LOGIN)).rejects.toBeInstanceOf(SystemsRefused);
      expect(written).toHaveLength(0);
    }
  });

  it('refuses a refused panel: a new login does not change its answers', async () => {
    const { service, written, updates } = harness({ reviewState: PanelReviewState.refused, connectionTestFault: null });
    await expect(service.resubmitCredentials(actor, PANEL, LOGIN)).rejects.toMatchObject({ reason: 'panel_refused' });
    await expect(service.resubmitCredentials(actor, PANEL, LOGIN)).rejects.toBeInstanceOf(PanelResubmitRefused);
    expect(written).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('rotates a pending panel\'s login and clears its last test, conditional on pending, so the next tick re-tests', async () => {
    const { service, panel, updates, written } = harness({});
    const out = await service.resubmitCredentials(actor, PANEL, LOGIN);

    expect(written).toEqual([{ tenantId: OWNER, panelId: PANEL, credentials: LOGIN, actorId: ADMIN }]);
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toMatchObject({ id: PANEL, reviewState: PanelReviewState.pending });
    expect(panel).toMatchObject({ connectionTestedAt: null, connectionTestFault: null, connectionTestDetail: null });
    expect(out).toEqual({
      id: PANEL,
      reviewState: PanelReviewState.pending,
      retest: true,
      credentials: { configured: true, version: 2, rotatedAt: '2026-09-24T10:00:00.000Z' },
    });
  });

  it('keeps a rate_limited fault and its time: the cool-off is not skipped', async () => {
    const { service, panel, updates, written } = harness({ connectionTestFault: ConnectionTestFault.rate_limited });
    const out = await service.resubmitCredentials(actor, PANEL, LOGIN);

    expect(written).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(panel).toMatchObject({ connectionTestedAt: TESTED, connectionTestFault: ConnectionTestFault.rate_limited });
    expect(out.retest).toBe(false);
  });

  it.each([PanelReviewState.accepted, PanelReviewState.accepted_low_trust])(
    'rotates an %s panel and leaves its review alone',
    async (reviewState) => {
      const { service, panel, updates, written } = harness({ reviewState, connectionTestFault: null });
      const out = await service.resubmitCredentials(actor, PANEL, LOGIN);

      expect(written).toHaveLength(1);
      expect(updates).toHaveLength(0);
      expect(panel?.reviewState).toBe(reviewState);
      expect(out).toMatchObject({ reviewState, retest: false });
    },
  );

  it('changes nothing on the row when the vault fails', async () => {
    const { service, panel, updates } = harness({}, { vaultFails: true });
    await expect(service.resubmitCredentials(actor, PANEL, LOGIN)).rejects.toThrow('tenant-service did not answer');
    expect(updates).toHaveLength(0);
    expect(panel).toMatchObject({ connectionTestedAt: TESTED, connectionTestFault: ConnectionTestFault.timeout });
  });

  it('reports no retest when the tick wrote a verdict while the vault was answering', async () => {
    const { service, panel } = harness({}, { duringVault: (p) => (p.reviewState = PanelReviewState.accepted) });
    const out = await service.resubmitCredentials(actor, PANEL, LOGIN);
    expect(out.retest).toBe(false);
    // The verdict the tick wrote stands, with the test it was read off.
    expect(panel).toMatchObject({ reviewState: PanelReviewState.accepted, connectionTestedAt: TESTED });
  });
});

describe('resubmitCredentialsSchema', () => {
  it('takes the login alone, 1–4096, untrimmed', () => {
    expect(resubmitCredentialsSchema.parse({ credentials: ' pw ' })).toEqual({ credentials: ' pw ' });
    expect(resubmitCredentialsSchema.safeParse({ credentials: '' }).success).toBe(false);
    expect(resubmitCredentialsSchema.safeParse({ credentials: 'x'.repeat(4097) }).success).toBe(false);
    expect(resubmitCredentialsSchema.safeParse({ credentials: 'pw', reviewState: 'accepted' }).success).toBe(false);
  });
});
