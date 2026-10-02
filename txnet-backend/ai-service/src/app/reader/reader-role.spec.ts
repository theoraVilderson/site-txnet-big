import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AI_READER_PLATFORM_TABLES, AI_READER_TABLES, AI_READER_VIEWS } from './reader-tables';

/**
 * F-038-b, ADR-0109 point 6: `ai-service` reads other units' tables through a
 * role that can only SELECT, only the tables named here, and only one tenant's
 * rows at a time.
 *
 * Every one of those three is silent when it fails. A role that inherits
 * `txnet_app` can write the ledger; a grant on a whole schema reaches the
 * vault's keys; a policy without the tenant clause reads every reseller's
 * customers. None of that breaks a test of the engine, so this spec reads the
 * migration and the login-role script off disk and asks each question.
 */

const ROOT = join(__dirname, '../../../../..');
const MIGRATIONS = join(ROOT, 'txnet-backend/prisma/domains/migrations');
/** Every migration that grants the reader something, in order. */
const READER_MIGRATIONS = ['20261002000300_ai_reader_role', '20261002000400_ai_profile_inputs', '20261002000500_ai_predictions_v1', '20261002000600_ai_quiet_down_inputs', '20261002000700_ai_decision_inputs', '20261002000800_ai_margin_inputs', '20261002001400_ai_package_rate_view', '20261002001600_ai_reseller_inputs', '20261002001700_ai_reseller_upgrade_inputs'];

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The migrations with their comments removed: prose about a grant is not a grant. */
const sql = READER_MIGRATIONS.map((m) => read(join(MIGRATIONS, m, 'migration.sql')))
  .join('\n')
  .replace(/--[^\n]*/g, '');
const loginRoles = read(join(ROOT, 'scripts/db-login-roles.sh'));

describe('the ai reader role (F-038-b, ADR-0109 point 6)', () => {
  it('is a group role that cannot log in or bypass RLS', () => {
    expect(sql).toMatch(/CREATE ROLE txnet_ai_reader NOLOGIN NOBYPASSRLS/);
  });

  it('is granted nothing but SELECT', () => {
    expect(sql).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*TO txnet_ai_reader/i);
    expect(sql).not.toMatch(/ON ALL TABLES[^;]*TO txnet_ai_reader/i);
    expect(sql).not.toMatch(/GRANT txnet_(app|cross_tenant) TO txnet_ai_reader/);
  });

  it('reads no network-layer table', () => {
    expect(AI_READER_TABLES.some((t) => t.table.startsWith('network.'))).toBe(false);
    expect(sql).not.toMatch(/\bnetwork\./);
  });

  it.each(AI_READER_TABLES.map((t) => [t.table, t]))('%s: SELECT granted and scoped to the tenant', (_, t) => {
    const [schema, name] = t.table.split('.');
    expect(sql).toMatch(new RegExp(`GRANT SELECT(\\s*\\([^)]*\\))? ON ${schema}\\.${name} TO txnet_ai_reader;`));
    const tenantClause = t.sharedRead
      ? `\\("tenantId" IS NULL OR "tenantId" = public\\.current_tenant_id\\(\\)\\)`
      : `\\("tenantId" = public\\.current_tenant_id\\(\\)\\)`;
    expect(sql).toMatch(
      new RegExp(`CREATE POLICY ai_reader ON ${schema}\\.${name}\\s+AS PERMISSIVE FOR SELECT TO txnet_ai_reader\\s+USING ${tenantClause};`),
    );
  });

  it('grants nothing on a table it does not name', () => {
    const granted = [...sql.matchAll(/GRANT SELECT(?:\s*\([^)]*\))? ON ([a-z_]+\.[a-z_]+) TO txnet_ai_reader/g)].map((m) => m[1]);
    expect(granted.sort()).toEqual([...AI_READER_TABLES.map((t) => t.table), ...AI_READER_PLATFORM_TABLES.map((t) => t.table), ...AI_READER_VIEWS.map((v) => v.view)].sort());
  });

  it.each(AI_READER_PLATFORM_TABLES.map((t) => [t.table, t]))('%s: the platform\'s own terms, SELECT by the columns it names', (_, t) => {
    const [schema, name] = t.table.split('.');
    const grant = new RegExp(`GRANT SELECT(?:\\s*\\(([^)]*)\\))? ON ${schema}\\.${name} TO txnet_ai_reader;`).exec(sql);
    expect(grant).not.toBeNull();
    if (t.columns) expect((grant?.[1] ?? '').split(',').map((c) => c.trim().replace(/"/g, '')).sort()).toEqual([...t.columns].sort());
    else expect(grant?.[1]).toBeUndefined();
  });

  it('reads a person by id and status, never their name, contact or secrets', () => {
    const grant = /GRANT SELECT\s*\(([^)]*)\) ON identity\.user TO txnet_ai_reader/.exec(sql)?.[1] ?? '';
    expect(grant).toContain('"tenantId"');
    for (const column of ['passwordHash', 'twoFactorSecret', 'phoneNumber', 'email', 'fullName', 'username']) {
      expect(grant).not.toContain(`"${column}"`);
    }
  });

  it.each(AI_READER_VIEWS.map((v) => [v.view, v]))('%s: scoped by the bound tenant, named columns only', (_, v) => {
    const [schema, name] = v.view.split('.');
    const body = new RegExp(`CREATE VIEW ${schema}\\.${name} WITH \\(security_barrier\\) AS([^;]*);`).exec(sql)?.[1] ?? '';
    // Through its user (`u`), the tenant's own subscription (`s`), or — the resellers — only the platform owner bound (`me`).
    expect(body).toMatch(/\b[us]\."tenantId" = public\.current_tenant_id\(\)|\bme\."id" = public\.current_tenant_id\(\) AND me\."tenantType" = 'platform_owner'/);
    expect(body).not.toMatch(/\bOR\b/);
    const selected = /SELECT([\s\S]*?)FROM/.exec(body)?.[1] ?? '';
    expect(selected).not.toContain('*');
    for (const column of v.columns) expect(selected).toContain(`"${column}"`);
    for (const column of v.forbidden) expect(selected).not.toContain(`"${column}"`);
    expect(sql).toMatch(new RegExp(`GRANT SELECT ON ${schema}\\.${name} TO txnet_ai_reader;`));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON [^;]*${schema}\\.${name}[^;]* FROM PUBLIC, txnet_app, txnet_cross_tenant;`));
  });

  it('has a login role that holds the reader and nothing else', () => {
    expect(loginRoles).toMatch(/CREATE ROLE txnet_ai_reader_user LOGIN/);
    expect(loginRoles).toMatch(/ALTER ROLE txnet_ai_reader_user\s+NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE/);
    expect(loginRoles).toMatch(/GRANT txnet_ai_reader\s+TO txnet_ai_reader_user/);
    expect(loginRoles).toMatch(/REVOKE txnet_app\s+FROM txnet_ai_reader_user/);
    expect(loginRoles).toMatch(/REVOKE txnet_cross_tenant\s+FROM txnet_ai_reader_user/);
  });
});
