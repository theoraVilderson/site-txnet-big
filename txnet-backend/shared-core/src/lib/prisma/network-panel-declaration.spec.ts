import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-027-a turns on the declaration ADR-0074 rests on: a Panel says how it
 * counts usage and how it is reached, and those answers change arithmetic
 * rather than documenting it.
 *
 * This is the failure worth a spec because it is the one that is *silent*. A
 * missing `counterSemantics` is not a crash — it is a delta computed the
 * cumulative way over a session counter, which is a wrong number that looks
 * plausible. Neither is a missing *value*: drop `reset_on_read` from the enum
 * and the normaliser's third branch becomes unreachable, with nothing red.
 *
 * ADR-0071 has `network-service` assert its columns at boot and refuse to
 * start without them. That assertion cannot run in CI — the service is Go and
 * the database is not there — so the same question is asked here, of the two
 * files that must agree: `network.prisma` declares it, and the migration
 * history creates it. Both sides are read off disk; a hand-written list would
 * be edited by whoever forgot the column, on the day they forgot it.
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');

/** Every `migration.sql` in the history, concatenated. */
function migrationSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

const schema = readFileSync(join(DOMAINS, 'network.prisma'), 'utf8');
const sql = migrationSql();

/** The body of one `model` or `enum` block in `network.prisma`. */
function block(kind: 'model' | 'enum', name: string): string {
  const found = new RegExp(`^${kind}\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  if (!found) throw new Error(`network.prisma declares no ${kind} ${name}`);
  return found[1];
}

/** An enum's values, in declaration order, without the attributes. */
function enumValues(name: string): string[] {
  return block('enum', name)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[a-z][a-z0-9_]*$/.test(line));
}

/**
 * The columns the collector, the allocator and the convergence loop read. A
 * name removed here is a `network-service` that refuses to boot (ADR-0071),
 * so the list is the contract between the two languages.
 */
const PANEL_COLUMNS = [
  'ownershipType',
  'apiBaseUrl',
  'driverType',
  'counterSemantics',
  'transport',
  'capabilities',
  'reviewState',
  'connectionTestedAt',
  'connectionTestFault',
  'connectionTestDetail',
  'orphanPolicy',
  'panelState',
  'blockedSince',
  'maxRequestsPerMinute',
  'maxLineRateBps',
  'observedWriteLatencyMs',
  'lastHealthyAt',
  'lastSuccessfulCollectionAt',
];

describe('network.Panel declares its driver, its counter and its transport', () => {
  const panel = block('model', 'Panel');

  it.each(PANEL_COLUMNS)('the schema declares %s', (column) => {
    expect(panel).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
  });

  it.each(PANEL_COLUMNS)('the migration history creates %s', (column) => {
    expect(sql).toContain(`"${column}"`);
  });

  it('keeps the counter semantics at exactly the three the normaliser handles', () => {
    // ADR-0074: one normaliser, three arithmetic variants and no fourth. A
    // value added here without a branch is usage counted the wrong way.
    expect(enumValues('CounterSemantics')).toEqual(['cumulative', 'session', 'reset_on_read']);
  });

  it('keeps the transports at exactly the two the pipeline has', () => {
    expect(enumValues('PanelTransport')).toEqual(['pull', 'push']);
  });

  it('names a driver for every family we have said we would carry', () => {
    // ADR-0071's six families, plus `fake` — the driver the conformance suite
    // runs against before any real one exists (F-027-j).
    expect(enumValues('DriverType')).toContain('fake');
    expect(enumValues('DriverType')).toHaveLength(14);
    // The two x-ui forks are two families, not one value opened two ways
    // (F-027-bc): each has its own API and its own questionnaire.
    expect(enumValues('DriverType')).toEqual(expect.arrayContaining(['x_ui_alireza', 'x_ui_vaxilu']));
    expect(enumValues('DriverType')).not.toContain('x_ui');
  });

  it('distinguishes a panel that is refusing us from one that is down', () => {
    // A `429`/`403` is answered, not dead: it is never retried through, and
    // retrying is what makes a temporary ban permanent (ADR-0072).
    expect(enumValues('PanelState')).toContain('throttled_or_blocked');
    expect(enumValues('PanelState')).toContain('down');
  });

  it('says why a connection test gave no verdict, and only on a pending panel', () => {
    // ADR-0080: an unreachable panel did not answer, so it is not `refused`.
    // The six are `driver.FaultKind`; `network-service/internal/register`
    // mirrors all eight as `register.FaultKind`.
    expect(enumValues('ConnectionTestFault')).toEqual([
      'timeout', 'rate_limited', 'blocked', 'unavailable', 'unsupported', 'protocol',
      'unopenable', 'invalid_answers',
    ]);
    expect(sql).toContain('panel_connection_fault_is_pending_only');
  });

  it('carries every protocol a driver family can report', () => {
    expect(enumValues('ConfigProtocol')).toHaveLength(9);
  });

  it('has no `panelType` left to disagree with `driverType`', () => {
    // C-09: a closed set of wire values is declared once. `PanelType` named
    // two Xray builds and `DriverType` names every family, so a row
    // carrying both could say two different things about the same panel.
    expect(schema).not.toContain('panelType');
    expect(schema).not.toContain('enum PanelType');
  });

  it('cannot hold a panel whose ownership and tenant disagree', () => {
    // One fact written twice: alert routing and cost attribution read
    // `ownershipType`, RLS reads `tenantId`. The database keeps them equal.
    expect(sql).toContain('panel_ownership_matches_tenant');
  });
});
