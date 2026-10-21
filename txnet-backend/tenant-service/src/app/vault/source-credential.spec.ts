/**
 * An import's source login (F-201-d, D-63): the address and login of the panel
 * a reseller is leaving, kept in its own vault for one run and read back by
 * `network-service`'s source read (F-201-b) alone.
 *
 * The invariants: it is admitted by `ResellerAccess` with `migration.manage`;
 * it is stored only for a run of this reseller that has not closed; it is
 * never answered to the reseller; a read restarts its 7 days; and a run that
 * committed or was cancelled destroys it — the ciphertext gone, not revoked.
 */
import { MigrationRunKind, MigrationRunStatus, TenantCredentialKind } from '@prisma/client';
import { CredentialUnavailable, ResellerAccessRefused, SOURCE_CREDENTIAL_TTL_MS, sourceCredentialLabel } from '@txnet-backend/shared-core';

import { SOURCE_READER_CALLER, SourceCredentialRefused, SourceCredentialService } from './source-credential.service';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const ACTOR = { userId: '55555555-5555-4555-8555-555555555555', tenantId: RESELLER, permissions: ['migration.manage'] };
const LOGIN = { apiBaseUrl: 'https://old.example.test:2053/secret-path', clientBaseUrl: null, login: 'admin:hunter2' };
const NOW = new Date('2026-10-21T10:00:00Z');

type Ref = { tenantId: string; kind: TenantCredentialKind; label?: string };
type Run = { tenantId: string; kind: MigrationRunKind; status: MigrationRunStatus };

function build(run: Run | null = { tenantId: RESELLER, kind: MigrationRunKind.panel, status: MigrationRunStatus.draft }) {
  const stored = new Map<string, { value: string; expiresAt: Date | null }>();
  const key = (ref: Ref) => `${ref.tenantId}/${ref.kind}/${ref.label}`;
  const vault = {
    put: vi.fn(async (ref: Ref, value: string, options: { expiresAt?: Date | null } = {}) => {
      stored.set(key(ref), { value, expiresAt: options.expiresAt ?? null });
      return { configured: true, expiresAt: options.expiresAt ?? null };
    }),
    use: vi.fn(async (ref: Ref, _access: { caller: string }) => {
      const row = stored.get(key(ref));
      if (!row) throw new CredentialUnavailable(ref, 'missing');
      return row.value;
    }),
    destroy: vi.fn(async (ref: Ref) => (stored.delete(key(ref)) ? 1 : 0)),
  };
  const prisma = {
    migrationRun: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) =>
        run && where.id === RUN && where.tenantId === run.tenantId ? { kind: run.kind, status: run.status } : null,
      ),
    },
  };
  const door = { admit: vi.fn(async () => ({ id: RESELLER, slug: 'r', as: 'member' as const })) };
  const access = { for: vi.fn(() => door) };
  const service = new SourceCredentialService(vault as never, prisma as never, access as never);
  const ref = { tenantId: RESELLER, kind: TenantCredentialKind.source_panel_credentials, label: sourceCredentialLabel(RUN) };
  return { service, vault, door, access, stored, ref, key };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  const e = await work.then(() => null, (err: unknown) => err);
  if (!(e instanceof SourceCredentialRefused)) throw new Error(`expected a SourceCredentialRefused, got ${String(e)}`);
  return e.reason;
}

describe('SourceCredentialService', () => {
  it('stores address and login under the run, for 7 days, and answers neither', async () => {
    const { service, vault, access, door, stored, ref, key } = build();
    const state = await service.set(ACTOR, RESELLER, RUN, LOGIN, NOW);

    expect(access.for).toHaveBeenCalledWith('migration.manage');
    expect(door.admit).toHaveBeenCalledWith(ACTOR, RESELLER, 'staffWrite');
    expect(state).toEqual({ configured: true, expiresAt: new Date(NOW.getTime() + SOURCE_CREDENTIAL_TTL_MS) });
    expect(JSON.stringify(state)).not.toContain('hunter2');
    expect(JSON.stringify(state)).not.toContain('secret-path');
    expect(JSON.parse(stored.get(key(ref))?.value ?? '{}')).toEqual(LOGIN);
    expect(vault.put).toHaveBeenCalledWith(ref, expect.any(String), expect.objectContaining({ createdBy: ACTOR.userId }));
  });

  it('is refused by the door before anything is read or stored', async () => {
    const { service, vault, door } = build();
    door.admit.mockRejectedValueOnce(new ResellerAccessRefused('not_allowed'));
    expect(await refusal(service.set(ACTOR, RESELLER, RUN, LOGIN, NOW))).toBe('not_allowed');
    expect(vault.put).not.toHaveBeenCalled();
  });

  it("stores nothing for another tenant's run, a run that is not a panel's, or a closed one", async () => {
    expect(await refusal(build({ tenantId: OTHER, kind: MigrationRunKind.panel, status: MigrationRunStatus.draft }).service.set(ACTOR, RESELLER, RUN, LOGIN, NOW))).toBe('run_not_found');
    expect(await refusal(build({ tenantId: RESELLER, kind: MigrationRunKind.link, status: MigrationRunStatus.draft }).service.set(ACTOR, RESELLER, RUN, LOGIN, NOW))).toBe('not_a_panel_run');
    const closed = build({ tenantId: RESELLER, kind: MigrationRunKind.panel, status: MigrationRunStatus.committing });
    expect(await refusal(closed.service.set(ACTOR, RESELLER, RUN, LOGIN, NOW))).toBe('run_closed');
    expect(closed.vault.put).not.toHaveBeenCalled();
  });

  it('answers the source read, logged as its caller, and starts the 7 days again', async () => {
    const { service, vault, stored, ref, key } = build();
    await service.set(ACTOR, RESELLER, RUN, LOGIN, NOW);
    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);

    expect(await service.use(RESELLER, RUN, later)).toEqual(LOGIN);
    expect(vault.use).toHaveBeenCalledWith(ref, { caller: SOURCE_READER_CALLER });
    expect(stored.get(key(ref))?.expiresAt).toEqual(new Date(later.getTime() + SOURCE_CREDENTIAL_TTL_MS));
  });

  it('is never read across tenants: the run is looked up in the tenant the caller names', async () => {
    const { service, vault } = build();
    expect(await refusal(service.use(OTHER, RUN, NOW))).toBe('credential_unavailable');
    expect(vault.use).not.toHaveBeenCalled();
  });

  it('destroys the login when the run has committed or been cancelled, and refuses the read', async () => {
    for (const status of [MigrationRunStatus.committing, MigrationRunStatus.committed, MigrationRunStatus.cancelled, MigrationRunStatus.expired]) {
      const { service, vault, stored, ref, key } = build({ tenantId: RESELLER, kind: MigrationRunKind.panel, status });
      stored.set(key(ref), { value: JSON.stringify(LOGIN), expiresAt: null });
      expect(await refusal(service.use(RESELLER, RUN, NOW)), status).toBe('credential_unavailable');
      expect(vault.use, status).not.toHaveBeenCalled();
      expect(stored.has(key(ref)), status).toBe(false);
    }
  });

  it("destroys on the engine's word and on the reseller's, behind the door", async () => {
    const engine = build();
    await engine.service.set(ACTOR, RESELLER, RUN, LOGIN, NOW);
    expect(await engine.service.destroy(RESELLER, RUN)).toBe(1);
    expect(engine.vault.destroy).toHaveBeenCalledWith(engine.ref);

    const reseller = build();
    await reseller.service.set(ACTOR, RESELLER, RUN, LOGIN, NOW);
    await reseller.service.remove(ACTOR, RESELLER, RUN);
    expect(reseller.access.for).toHaveBeenLastCalledWith('migration.manage');
    expect(reseller.stored.size).toBe(0);
  });

  it('refuses a stored value it did not write rather than answer it', async () => {
    const { service, stored, ref, key } = build();
    stored.set(key(ref), { value: 'admin:hunter2', expiresAt: null });
    expect(await refusal(service.use(RESELLER, RUN, NOW))).toBe('credential_unavailable');
  });
});
