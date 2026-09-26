import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-027-c gives the network schema the six tables the usage pipeline keeps its
 * state in. Every one of them exists to make the same promise mechanical: a
 * measured byte is billed, held or quarantined, and never silently dropped
 * (ADR-0074, `in doubt, do not charge`).
 *
 * - `ConfigCounterState` is the collector's memory of the raw counter, which
 *   is what makes a reset a reset rather than negative usage.
 * - `UsageDeltaSeen` makes the delta's own id the primary key, so applying a
 *   redelivered message is a constraint violation rather than a second charge.
 * - `UsageDeltaQuarantine` and `UsageHold` are the two places a byte waits:
 *   one for a figure we do not believe, one for a figure we believe but a
 *   declared incapacity stops us billing. Both end `released` or
 *   `written_off` — never `pending` forever and unaccounted.
 * - `PanelDriftEvent` is the panel-wide stop (F-027-ab): a backup restore
 *   looks like thousands of plausible resets.
 * - `UnattributedUsage` is the byte we measured and could not place. It has a
 *   row precisely so it cannot be dropped.
 *
 * Same method as `network-panel-declaration.spec.ts` and
 * `network-config-desired-state.spec.ts`: schema and migration history are
 * both read off disk, because a hand-written list would be edited by whoever
 * forgot the column, on the day they forgot it.
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
 * Model -> table, and the columns `network-service` reads (ADR-0071 has it
 * refuse to boot on a missing one, so this list is the contract between the
 * two languages).
 */
const TABLES: Record<string, { table: string; columns: string[] }> = {
  ConfigCounterState: {
    table: 'config_counter_state',
    columns: [
      'configId',
      'panelId',
      'counterSemantics',
      'lastUpBytes',
      'lastDownBytes',
      'lifetimeUpBytes',
      'lifetimeDownBytes',
      'lastObservedAt',
      'lastPublishedAt',
      'resetCount',
      'lastResetAt',
    ],
  },
  UsageDeltaSeen: {
    table: 'usage_delta_seen',
    columns: ['deltaId', 'configId', 'panelId', 'upBytes', 'downBytes', 'observedAt', 'seenAt'],
  },
  UsageDeltaQuarantine: {
    table: 'usage_delta_quarantine',
    columns: [
      'deltaId',
      'configId',
      'panelId',
      'upBytes',
      'downBytes',
      'observedAt',
      'reason',
      'state',
      'detectedAt',
      'resolvedAt',
      'resolvedByAdminId',
      'resolutionNote',
    ],
  },
  UsageHold: {
    table: 'usage_hold',
    columns: [
      'configId',
      'panelId',
      'upBytes',
      'downBytes',
      'reason',
      'state',
      'heldFrom',
      'heldAt',
      'resolvedAt',
      'resolvedByAdminId',
      'resolutionNote',
    ],
  },
  PanelDriftEvent: {
    table: 'panel_drift_event',
    columns: [
      'panelId',
      'eventType',
      'affectedConfigCount',
      'observedConfigCount',
      'detectedAt',
      'collectionHalted',
      'acknowledgedAt',
      'acknowledgedByAdminId',
      'note',
    ],
  },
  UnattributedUsage: {
    table: 'unattributed_usage',
    columns: [
      'panelId',
      'remoteIdentifier',
      'upBytes',
      'downBytes',
      'observationCount',
      'firstSeenAt',
      'lastSeenAt',
      'state',
      'attributedConfigId',
      'resolvedAt',
      'note',
    ],
  },
};

describe('network usage accounting: a byte is billed, held or quarantined', () => {
  it.each(Object.entries(TABLES))('%s is a model on the network schema', (name, { table }) => {
    expect(block('model', name)).toMatch(new RegExp(`@@schema\\("network"\\)`));
    expect(block('model', name)).toContain(`@@map("${table}")`);
    expect(sql).toContain(`"network"."${table}"`);
  });

  it.each(
    Object.entries(TABLES).flatMap(([name, { columns }]) =>
      columns.map((column) => [name, column] as const),
    ),
  )('%s declares %s, in the schema and in the migration history', (name, column) => {
    expect(block('model', name)).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
    expect(sql).toContain(`"${column}"`);
  });

  it('counts every byte in 64 bits', () => {
    // A 32-bit counter wraps at 4 GB — the RADIUS Gigawords trap (ADR-0074)
    // arriving a second time, in our own storage.
    const byteColumns: [string, string][] = [
      ['ConfigCounterState', 'lastUpBytes'],
      ['ConfigCounterState', 'lifetimeDownBytes'],
      ['UsageDeltaSeen', 'upBytes'],
      ['UsageDeltaQuarantine', 'downBytes'],
      ['UsageHold', 'upBytes'],
      ['UnattributedUsage', 'downBytes'],
    ];
    for (const [model, column] of byteColumns) {
      expect(block('model', model)).toMatch(new RegExp(`^\\s*${column}\\s+BigInt`, 'm'));
    }
  });

  it('makes the delta its own dedupe key', () => {
    // Exactly-once effect over at-least-once delivery (F-027-n): the id of the
    // published delta *is* the primary key, so a redelivery is a constraint
    // violation the consumer absorbs, not a second charge.
    expect(block('model', 'UsageDeltaSeen')).toMatch(/^\s*deltaId\s+String\s+@id/m);
  });

  it('sweeps what it has seen by age', () => {
    // The dedupe table is unbounded otherwise. 48h is the sweep window, and it
    // needs an index on the column the sweep ranges over.
    expect(sql).toContain('usage_delta_seen_seenAt_idx');
  });

  it('keeps one counter cursor per config', () => {
    // Two cursors for one config is two opinions about where the counter was,
    // and the losing one re-counts everything since the last reset.
    expect(block('model', 'ConfigCounterState')).toMatch(/^\s*configId\s+String\s+@unique/m);
  });

  it('remembers the semantics the cursor was computed under', () => {
    // ADR-0074: the arithmetic differs per counter type. A panel re-declared
    // from `cumulative` to `session` invalidates the cursor, and a cursor that
    // does not say what it meant cannot be invalidated.
    expect(block('model', 'ConfigCounterState')).toMatch(/^\s*counterSemantics\s+CounterSemantics/m);
  });

  it('ends a hold and a quarantine in exactly two ways', () => {
    // C-09, and the promise itself: `pending` is the only open state, and the
    // two closed ones are `released` (billed) and `written_off` (ours). There
    // is no `dropped`.
    expect(enumValues('UsageDispositionState')).toEqual(['pending', 'released', 'written_off']);
    expect(block('model', 'UsageHold')).toMatch(
      /^\s*state\s+UsageDispositionState\s+@default\(pending\)/m,
    );
    expect(block('model', 'UsageDeltaQuarantine')).toMatch(
      /^\s*state\s+UsageDispositionState\s+@default\(pending\)/m,
    );
  });

  it('names why a byte is held, and every reason is a declared incapacity', () => {
    // ADR-0074: "a declared incapacity holds bytes rather than guessing at
    // them". A hold with no reason is a number nobody can adjudicate.
    expect(enumValues('HoldReason')).toEqual([
      'gigawords_missing',
      'session_never_closed',
      'publish_failed_after_read',
      'attribution_ambiguous',
      'panel_drift_event',
      'low_trust_source',
    ]);
  });

  it('names why a figure is not believed', () => {
    expect(enumValues('QuarantineReason')).toEqual([
      'implausible_volume',
      'implausible_rate',
      'reset_with_unmeasured_bytes',
      'semantics_mismatch',
      'clock_went_backward',
      'panel_drift_event',
    ]);
  });

  it('cannot hold a resolved hold or quarantine with no time of resolution', () => {
    // The holds queue (F-027-ad) is the visible face of the promise. A row
    // resolved at no time cannot be aged, audited or reported on.
    expect(sql).toContain('usage_hold_resolved_has_time');
    expect(sql).toContain('usage_delta_quarantine_resolved_has_time');
  });

  it('gives the holds queue the index it is read by', () => {
    // Everything still open, oldest first — the one query the queue makes.
    expect(sql).toContain('usage_hold_state_heldAt_idx');
  });

  it('refuses a negative byte figure anywhere', () => {
    // A counter going backward is a reset, never negative usage (ADR-0074).
    for (const constraint of [
      'config_counter_state_bytes_not_negative',
      'usage_delta_seen_bytes_not_negative',
      'usage_delta_quarantine_bytes_not_negative',
      'usage_hold_bytes_not_negative',
      'unattributed_usage_bytes_not_negative',
    ]) {
      expect(sql).toContain(constraint);
    }
  });

  it('records a drift event over a population, not a config', () => {
    // F-027-ab: more than X% of one panel's clients going backward is a
    // restore, not X thousand resets. The verdict needs both counts to be a
    // ratio anyone can check afterwards.
    expect(enumValues('PanelDriftEventType')).toEqual([
      'mass_reset',
      'mass_missing',
      'mass_rename',
      'mass_limit_override',
      // F-027-cf: a panel answering with another panel's clients, named in
      // `foreignPanelId`. Its own migration, so the value is committed first.
      'foreign_claim',
    ]);
    expect(sql).toContain('panel_drift_event_counts_sane');
  });

  it('halts collection by default when drift is detected', () => {
    // ~$16k of wrong charges in a minute is the cost of carrying on. The
    // default is the safe one; resuming is a decision someone makes.
    expect(block('model', 'PanelDriftEvent')).toMatch(
      /^\s*collectionHalted\s+Boolean\s+@default\(true\)/m,
    );
  });

  it('accumulates unattributed usage per remote client instead of per reading', () => {
    // An orphan is re-observed every pass. Without the unique key, one
    // unclaimed client on a busy panel is a row a minute forever.
    expect(sql).toContain('unattributed_usage_panel_remote_key');
    expect(enumValues('UnattributedUsageState')).toEqual(['open', 'attributed', 'dismissed']);
  });

  it('cannot call unattributed usage attributed without naming the config', () => {
    // Otherwise "we found its owner" is a claim with nothing behind it, and
    // the bytes are dropped under a state that says they were not.
    expect(sql).toContain('unattributed_usage_attributed_has_config');
  });
});
