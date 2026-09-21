import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-027-b turns on the other half of the declaration F-027-a started: a Panel
 * says how it counts, and a Config says what it is *supposed* to be. Every
 * column here is a desired state the convergence loop drives towards, or a
 * figure it compares against — never a command that was queued and replayed
 * (ADR-0075).
 *
 * The failure worth a spec is again the silent one. `allocatedCeilingBytes`
 * and `appliedCeilingBytes` are deliberately two columns: the first is what
 * the allocator decided, the second is what the panel confirmed, and the gap
 * between them is the work the loop has left to do (ADR-0072). Collapse them
 * into one and nothing goes red — the system simply believes a ceiling it
 * never managed to write, which is free traffic at the far end of it.
 *
 * Same method as `network-panel-declaration.spec.ts`: both sides are read off
 * disk, because a hand-written list would be edited by whoever forgot the
 * column, on the day they forgot it.
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
 * The columns the allocator, the convergence loop and the purge job read. A
 * name removed here is a `network-service` that refuses to boot (ADR-0071),
 * so the list is the contract between the two languages.
 */
const CONFIG_COLUMNS = [
  'remoteId',
  'claimTag',
  'credentialGroupId',
  'desiredEnabled',
  'desiredRemote',
  'enforcementState',
  'driftState',
  'driftRepairCount',
  'lastReconciledAt',
  'allocatedCeilingBytes',
  'appliedCeilingBytes',
  'observedRateBps',
  'ceilingAppliedAt',
];

describe('network.Config carries its desired state, its drift and its ceiling', () => {
  const config = block('model', 'Config');

  it.each(CONFIG_COLUMNS)('the schema declares %s', (column) => {
    expect(config).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
  });

  it.each(CONFIG_COLUMNS)('the migration history creates %s', (column) => {
    expect(sql).toContain(`"${column}"`);
  });

  it('keeps what was allocated apart from what was applied', () => {
    // ADR-0072: the gap is the convergence loop's remaining work, and it is
    // what the panel shows as `in queue`. One column cannot hold both, and a
    // system that believes an unwritten ceiling serves traffic past it.
    expect(config).toMatch(/^\s*allocatedCeilingBytes\s+BigInt\?/m);
    expect(config).toMatch(/^\s*appliedCeilingBytes\s+BigInt\?/m);
  });

  it('counts bytes and bit rates in 64 bits', () => {
    // A 32-bit byte counter wraps at 4 GB — the RADIUS Gigawords trap
    // (ADR-0074) arriving a second time, in our own storage.
    for (const column of ['allocatedCeilingBytes', 'appliedCeilingBytes', 'observedRateBps']) {
      expect(config).toMatch(new RegExp(`^\\s*${column}\\s+BigInt`, 'm'));
    }
  });

  it('reaches the remote client by three keys, in that order', () => {
    // F-027-aa matches `remoteId` -> `claimTag` -> `uuid`. Without the tag a
    // rename orphans the usage and we cut off a user whose config works.
    expect(config).toMatch(/^\s*remoteId\s+String\?/m);
    expect(config).toMatch(/^\s*claimTag\s+String\?/m);
    expect(sql).toContain('config_panel_remote_id_key');
  });

  it('keeps the enforcement states at exactly the three a Grant reports on', () => {
    // ADR-0075: a Grant reports `purged` only once enforcement is `complete`,
    // so `partial` has to be expressible — a purge half-applied across five
    // panels is neither pending nor done.
    expect(enumValues('EnforcementState')).toEqual(['pending', 'partial', 'complete']);
  });

  it('states presence and enablement separately', () => {
    // ADR-0075 suspends first and purges later. One tri-state column would
    // make "disabled but still there" and "deleted" the same row.
    expect(enumValues('DesiredRemote')).toEqual(['present', 'absent']);
    expect(config).toMatch(/^\s*desiredEnabled\s+Boolean\s+@default\(true\)/m);
  });

  it('names every drift verdict the loop can reach, and no other', () => {
    // C-09: a closed set of wire values is declared once. `contested` is the
    // anti-flap stop (F-027-ab) and is a verdict like the rest — a config the
    // loop has given up repairing is not `synced`.
    expect(enumValues('DriftState')).toEqual([
      'synced',
      'reset',
      'renamed',
      'rebuilt',
      'missing',
      'orphan',
      'limit_overridden',
      'contested',
    ]);
  });

  it('cannot hold a ceiling that was applied at no time', () => {
    // The clock on the write, exactly as `blockedSince` is the clock on a ban
    // (F-027-a). An applied ceiling with no timestamp cannot be aged out, so
    // a stale one is indistinguishable from a fresh one.
    expect(sql).toContain('config_applied_ceiling_needs_time');
  });

  it('cannot hold a purged config that still claims a remote client', () => {
    // ADR-0075: our rows are never deleted, `remoteId` is. A row that kept it
    // would have the convergence loop adopt a seat that was freed.
    expect(sql).toContain('config_purged_has_no_remote_id');
  });

  it('refuses a negative ceiling, rate or repair count', () => {
    // A counter going backward is a reset, never negative usage (ADR-0074).
    // The same rule holds for everything derived from one.
    expect(sql).toContain('config_ceiling_bytes_not_negative');
    expect(sql).toContain('config_observed_rate_not_negative');
    expect(sql).toContain('config_drift_repairs_not_negative');
  });
});
