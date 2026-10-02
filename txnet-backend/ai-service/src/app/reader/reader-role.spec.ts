import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AI_READER_TABLES } from './reader-tables';

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
const MIGRATION = join(
  ROOT,
  'txnet-backend/prisma/domains/migrations/20261002000300_ai_reader_role/migration.sql',
);

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The migration with its comments removed: prose about a grant is not a grant. */
const sql = read(MIGRATION).replace(/--[^\n]*/g, '');
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
    expect(granted.sort()).toEqual(AI_READER_TABLES.map((t) => t.table).sort());
  });

  it('reads a person by id and status, never their name, contact or secrets', () => {
    const grant = /GRANT SELECT\s*\(([^)]*)\) ON identity\.user TO txnet_ai_reader/.exec(sql)?.[1] ?? '';
    expect(grant).toContain('"tenantId"');
    for (const column of ['passwordHash', 'twoFactorSecret', 'phoneNumber', 'email', 'fullName', 'username']) {
      expect(grant).not.toContain(`"${column}"`);
    }
  });

  it('has a login role that holds the reader and nothing else', () => {
    expect(loginRoles).toMatch(/CREATE ROLE txnet_ai_reader_user LOGIN/);
    expect(loginRoles).toMatch(/ALTER ROLE txnet_ai_reader_user\s+NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE/);
    expect(loginRoles).toMatch(/GRANT txnet_ai_reader\s+TO txnet_ai_reader_user/);
    expect(loginRoles).toMatch(/REVOKE txnet_app\s+FROM txnet_ai_reader_user/);
    expect(loginRoles).toMatch(/REVOKE txnet_cross_tenant\s+FROM txnet_ai_reader_user/);
  });
});
