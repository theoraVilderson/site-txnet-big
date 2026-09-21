import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-027-d gives the network schema the one table a push source needs that a
 * pull source does not: the RADIUS session.
 *
 * A pull panel hands us a running total and `ConfigCounterState` remembers
 * where the counter was. A NAS hands us accounting packets about a *session*,
 * and the session is the unit of everything that can go wrong with it:
 *
 * - `Acct-Input-Octets` is 32 bits and wraps at 4 GB, with the high bits in
 *   `Acct-Input-Gigawords`. A NAS that omits Gigawords loses 4 GB per wrap in
 *   silence, so `gigawordsSeen` records whether this session's packets ever
 *   carried them — that flag is what turns bytes past the wrap into a
 *   `gigawords_missing` hold instead of a guess (ADR-0074).
 * - A session counter only ever rises, so the stored figure is a *high water
 *   mark*. A lower reading is a NAS restart, never negative usage.
 * - A session whose `Stop` never arrives closes at its last observed figure
 *   and is never extrapolated past it — which is only possible if a close
 *   always says which of those two it was.
 *
 * The table lands now rather than with the receiver (F-027-af) so that one
 * migration series covers the whole network schema.
 *
 * Same method as `network-usage-accounting.spec.ts`: the schema and the
 * migration history are both read off disk, because a hand-written list would
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
 * The columns `network-service` reads off this table (ADR-0071 has it refuse
 * to boot on a missing one, so this list is the contract between the two
 * languages).
 */
const COLUMNS = [
  'panelId',
  'nasId',
  'acctSessionId',
  'configId',
  'remoteIdentifier',
  'highWaterInBytes',
  'highWaterOutBytes',
  'publishedInBytes',
  'publishedOutBytes',
  'gigawordsSeen',
  'startedAt',
  'lastSeenAt',
  'closedAt',
  'closeReason',
];

describe('network RADIUS session: a session is closed, never abandoned', () => {
  it('is a model on the network schema', () => {
    expect(block('model', 'RadiusSession')).toContain('@@schema("network")');
    expect(block('model', 'RadiusSession')).toContain('@@map("radius_session")');
    expect(sql).toContain('"network"."radius_session"');
  });

  it.each(COLUMNS)('declares %s, in the schema and in the migration history', (column) => {
    expect(block('model', 'RadiusSession')).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
    expect(sql).toContain(`"${column}"`);
  });

  it('is one session per session id per NAS', () => {
    // `Acct-Session-Id` is unique only within the NAS that issued it, so the
    // pair is the identity. Without it, two NASes numbering their sessions
    // from 1 collide, and one user's traffic lands on another's session.
    expect(sql).toContain('radius_session_nas_acct_key');
    expect(block('model', 'RadiusSession')).toMatch(
      /@@unique\(\[nasId, acctSessionId\], map: "radius_session_nas_acct_key"\)/,
    );
  });

  it('counts every byte in 64 bits', () => {
    // The whole point of the table: the wire figure is 32 bits and wraps at
    // 4 GB. Storing the reconstructed total in 32 bits would be the Gigawords
    // trap a second time, in our own storage.
    for (const column of [
      'highWaterInBytes',
      'highWaterOutBytes',
      'publishedInBytes',
      'publishedOutBytes',
    ]) {
      expect(block('model', 'RadiusSession')).toMatch(new RegExp(`^\\s*${column}\\s+BigInt`, 'm'));
    }
  });

  it('records whether this session ever carried Gigawords', () => {
    // A declared incapacity holds bytes rather than guessing at them
    // (ADR-0074). Without the flag, a NAS that omits Gigawords is
    // indistinguishable from one whose user never passed 4 GB, and the
    // difference is 4 GB of traffic per wrap going missing in silence.
    expect(block('model', 'RadiusSession')).toMatch(
      /^\s*gigawordsSeen\s+Boolean\s+@default\(false\)/m,
    );
    expect(enumValues('HoldReason')).toContain('gigawords_missing');
  });

  it('never publishes more than it measured', () => {
    // A session with no `Stop` closes at its last observed figure and is never
    // extrapolated past it (ADR-0074). Published bytes above the high water
    // mark are exactly that extrapolation, arriving as a charge.
    expect(sql).toContain('radius_session_published_within_high_water');
  });

  it('refuses a negative byte figure', () => {
    // A reading below the high water mark is a NAS restart, never negative
    // usage — invariant 21, reaching the push side.
    expect(sql).toContain('radius_session_bytes_not_negative');
  });

  it('says why every closed session closed', () => {
    // `acct_stop` is one row of five, and the other four are the reasons a
    // figure is worth less than a `Stop` figure. A session closed for no
    // stated reason cannot be told apart from one closed on a real `Stop`,
    // which is where a stale session's last figure quietly becomes a final
    // one.
    expect(enumValues('RadiusSessionCloseReason')).toEqual([
      'acct_stop',
      'stale_timeout',
      'nas_restart',
      'superseded',
      'administrative',
    ]);
    expect(sql).toContain('radius_session_closed_has_reason');
  });

  it('leaves a session open with no close time and no reason', () => {
    // Both nullable, and the CHECK above binds them together: open is the
    // absence of both, never a half-closed row.
    expect(block('model', 'RadiusSession')).toMatch(/^\s*closedAt\s+DateTime\?/m);
    expect(block('model', 'RadiusSession')).toMatch(
      /^\s*closeReason\s+RadiusSessionCloseReason\?/m,
    );
  });

  it('can be read by the stale sweep and by attribution', () => {
    // The sweep asks for open sessions last seen before a cutoff; attribution
    // asks for one config's sessions. Those are the only two queries.
    expect(sql).toContain('radius_session_closedAt_lastSeenAt_idx');
    expect(sql).toContain('radius_session_configId_idx');
  });

  it('holds a session whose user it has not placed yet', () => {
    // `configId` is nullable and `remoteIdentifier` is not: the `User-Name`
    // the NAS reported is what a later attribution pass matches on, and
    // without the session row the bytes would be dropped for want of one.
    expect(block('model', 'RadiusSession')).toMatch(/^\s*configId\s+String\?/m);
    expect(block('model', 'RadiusSession')).toMatch(/^\s*remoteIdentifier\s+String\s*$/m);
  });
});
