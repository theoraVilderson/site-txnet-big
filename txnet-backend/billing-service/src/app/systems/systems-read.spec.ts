/**
 * The systems page's reads and its one drift action (F-027-as, ADR-0080
 * decision 2). What would break silently here:
 *
 *  - **whose panels.** Every read and the acknowledge are scoped from their
 *    first line: the platform owner sees the platform's panels and no
 *    reseller's, and a reseller is refused before any panel is read;
 *  - **the secret.** `panelApiCredentials` is never selected: a list that
 *    spreads the row would hand the vault reference to the page;
 *  - **the matrix's vocabulary.** The row keys are written by Go and read here.
 *    `contracts/network/capabilities.json` is their declared home; a key that
 *    drifts renders as a row nobody answered;
 *  - **the halt.** Acknowledging sets exactly what `collect.Containment.Halted`
 *    reads (`acknowledgedAt`), once. A second click must not rewrite who
 *    decided, and an event on a panel outside the scope is not found.
 */
import { PanelReviewState, PanelState, PanelTransport, TenantType } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CAPABILITIES_VERSION, CAPABILITY_ROWS } from './capabilities';
import { PanelScopeRefused } from './panel-scope';
import { SystemsRefused, SystemsReadService } from './systems-read';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PLATFORM_PANEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESELLER_PANEL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPEN_EVENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN_EVENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const FIXTURE = join(__dirname, '../../../../../contracts/network/capabilities.json');

type Row = Record<string, unknown>;

/** `where` as this service writes it: equality, `{in}`, and the `panel` relation. */
function matches(row: Row, where: Row, panels: Row[]): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'panel') {
      const panel = panels.find((p) => p['id'] === row['panelId']);
      return !!panel && matches(panel, v as Row, panels);
    }
    if (v && typeof v === 'object' && 'in' in (v as Row)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]));
}

function harness() {
  const selects: Array<Record<string, boolean>> = [];
  const panels: Row[] = [
    {
      id: PLATFORM_PANEL, tenantId: null, ownershipType: 'platform', name: 'de-fra-1', transport: PanelTransport.pull,
      reviewState: PanelReviewState.accepted, panelState: PanelState.healthy, maxRequestsPerMinute: 60,
      panelApiCredentials: `vault:${OWNER}:panel_credentials:panel:${PLATFORM_PANEL}`,
      capabilities: {
        version: CAPABILITIES_VERSION,
        answers: { per_client_usage: { supported: true }, per_client_rate_limit: { supported: false, detail: 'no speed cap' } },
      },
    },
    {
      id: RESELLER_PANEL, tenantId: RESELLER, ownershipType: 'tenant', name: 'their-own', transport: PanelTransport.push,
      reviewState: PanelReviewState.accepted, panelState: PanelState.healthy, maxRequestsPerMinute: 60,
      panelApiCredentials: 'vault:…', capabilities: null,
    },
  ];
  const events: Row[] = [
    { id: OPEN_EVENT, panelId: PLATFORM_PANEL, eventType: 'mass_reset', affectedConfigCount: 40, observedConfigCount: 100,
      detectedAt: new Date('2026-09-24T08:00:00Z'), collectionHalted: true, acknowledgedAt: null, acknowledgedByAdminId: null, note: null },
    { id: FOREIGN_EVENT, panelId: RESELLER_PANEL, eventType: 'mass_reset', affectedConfigCount: 9, observedConfigCount: 10,
      detectedAt: new Date('2026-09-24T08:00:00Z'), collectionHalted: true, acknowledgedAt: null, acknowledgedByAdminId: null, note: null },
  ];
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
      findMany: async ({ where, select }: { where: Row; select: Record<string, boolean> }) => {
        selects.push(select);
        return panels.filter((p) => matches(p, where, panels)).map((p) => pick(p, select));
      },
      findFirst: async ({ where, select }: { where: Row; select: Record<string, boolean> }) => {
        selects.push(select);
        const p = panels.find((row) => matches(row, where, panels));
        return p ? pick(p, select) : null;
      },
    },
    panelDriftEvent: {
      findMany: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) =>
        events.filter((e) => matches(e, where, panels)).map((e) => pick(e, select)),
      findFirst: async ({ where }: { where: Row }) => events.find((e) => matches(e, where, panels)) ?? null,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = events.filter((e) => matches(e, where, panels));
        hit.forEach((e) => Object.assign(e, data));
        return { count: hit.length };
      },
    },
  };
  const service = new SystemsReadService(prisma as never);
  return { service, events, selects };
}

const owner = { adminId: ADMIN, tenantId: OWNER };
const reseller = { adminId: ADMIN, tenantId: RESELLER };

describe('SystemsReadService', () => {
  it("lists the platform's panels only, with health and budget, and never selects the login", async () => {
    const { service, selects } = harness();
    const list = await service.panels(owner);

    expect(list.map((p) => p.id)).toEqual([PLATFORM_PANEL]);
    expect(list[0].health).toMatchObject({ panelState: PanelState.healthy, collectionHalted: true, openDriftEvents: 1 });
    expect(list[0].budget).toMatchObject({ maxRequestsPerMinute: 60 });
    expect(JSON.stringify(list)).not.toContain('vault:');
    for (const s of selects) expect(s).not.toHaveProperty('panelApiCredentials');
  });

  it('refuses a reseller before reading a panel, on every route', async () => {
    const { service, events } = harness();
    await expect(service.panels(reseller)).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.capabilities(reseller, RESELLER_PANEL)).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.driftEvents(reseller, {})).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.acknowledge(reseller, FOREIGN_EVENT, {})).rejects.toBeInstanceOf(PanelScopeRefused);
    expect(events[1]['acknowledgedAt']).toBeNull();
  });

  it('mirrors contracts/network/capabilities.json: every key, its scope and its severity', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      version: number;
      rows: Array<{ key: string; scope: string; severity: string }>;
    };
    expect(CAPABILITIES_VERSION).toBe(fixture.version);
    expect(CAPABILITY_ROWS.map(({ key, scope, severity }) => ({ key, scope, severity }))).toEqual(
      fixture.rows.map(({ key, scope, severity }) => ({ key, scope, severity })),
    );
  });

  it("renders the matrix: an answer, a no, a row nobody asked, and a row outside the panel's transport", async () => {
    const { service } = harness();
    const m = await service.capabilities(owner, PLATFORM_PANEL);
    const row = (key: string) => m.rows.find((r) => r.key === key);

    expect(m.rows).toHaveLength(CAPABILITY_ROWS.length);
    expect(row('per_client_usage')).toMatchObject({ state: 'supported' });
    expect(row('per_client_rate_limit')).toMatchObject({ state: 'unsupported', detail: 'no speed cap' });
    expect(row('bulk_usage_in_one_call')).toMatchObject({ state: 'unanswered', severity: 'required' });
    expect(row('gigawords_reported')).toMatchObject({ state: 'not_asked' });
  });

  it("does not show a reseller's panel's matrix to the owner", async () => {
    const { service } = harness();
    await expect(service.capabilities(owner, RESELLER_PANEL)).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('acknowledges once, as the halt reads it; a second click and a foreign event are refused', async () => {
    const { service, events } = harness();
    const ack = await service.acknowledge(owner, OPEN_EVENT, { note: 'backup restore on de-fra-1' });

    expect(ack).toMatchObject({ id: OPEN_EVENT, acknowledgedByAdminId: ADMIN, note: 'backup restore on de-fra-1' });
    expect(events[0]['acknowledgedAt']).toBeInstanceOf(Date);

    const first = events[0]['acknowledgedAt'];
    const again = service.acknowledge({ ...owner, adminId: 'someone-else' }, OPEN_EVENT, {});
    await expect(again).rejects.toBeInstanceOf(SystemsRefused);
    await expect(again).rejects.toMatchObject({ reason: 'already_acknowledged' });
    expect(events[0]['acknowledgedAt']).toBe(first);
    expect(events[0]['acknowledgedByAdminId']).toBe(ADMIN);

    await expect(service.acknowledge(owner, FOREIGN_EVENT, {})).rejects.toMatchObject({ reason: 'not_found' });
    expect(events[1]['acknowledgedAt']).toBeNull();
  });

  it('reports drift on the caller\'s panels only, open ones on request', async () => {
    const { service } = harness();
    const all = await service.driftEvents(owner, {});
    expect(all.items.map((e) => e.id)).toEqual([OPEN_EVENT]);
    expect(all.items[0]).toMatchObject({ panelName: 'de-fra-1', affectedConfigCount: 40, observedConfigCount: 100 });

    await service.acknowledge(owner, OPEN_EVENT, {});
    expect((await service.driftEvents(owner, { state: 'open' })).items).toEqual([]);
  });
});
