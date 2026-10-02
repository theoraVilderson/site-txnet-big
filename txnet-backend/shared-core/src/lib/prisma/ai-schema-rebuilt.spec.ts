import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-038-a rebuilds the `ai` schema (ADR-0109 point 5). The onboarding tables
 * carried no `tenantId` at all, so a service built on them would have read
 * every reseller's customers in one query — the one failure RLS exists for.
 *
 * Three things are worth a spec, all read off disk (as `rls-coverage.spec.ts`):
 *
 * - **Every new table is one tenant's**, from its first migration: a NOT NULL
 *   `tenantId` and a strict `tenant_isolation` policy, so the app pool cannot
 *   see another tenant's predictions even by a bug in a WHERE clause.
 * - **The old tables are gone**, with their VPN-shaped enums (`buy_addon_gb`):
 *   the engine is product-agnostic (point 3), and a second spelling of an
 *   action type is how two halves of a pipeline come to disagree (C-09).
 * - **The attention budget lives in `engagement`**, keyed by subject, and is
 *   never a ledger account (C-13).
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');
/** The rebuild, then every later migration that adds an `ai` table in its own migration. */
const AI_MIGRATIONS = ['20261002000200_ai_schema_rebuilt', '20261002000400_ai_profile_inputs'];

const ai = readFileSync(join(DOMAINS, 'ai.prisma'), 'utf8');
const engagement = readFileSync(join(DOMAINS, 'engagement.prisma'), 'utf8');

function sql(): string {
  return AI_MIGRATIONS.map((m) => {
    try {
      return readFileSync(join(MIGRATIONS, m, 'migration.sql'), 'utf8');
    } catch {
      return '';
    }
  }).join('\n');
}

/** `@@map` name -> model body, for every model in one schema file. */
function models(schema: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of schema.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm)) {
    const table = /@@map\("([^"]+)"\)/.exec(m[1])?.[1];
    if (table) found.set(table, m[1]);
  }
  return found;
}

const AI_TABLES = [
  'account_profile',
  'prediction',
  'action',
  'offer',
  'guardrail',
  'holdout',
  'opt_out',
  'provider',
  'task_route',
  'usage',
  'setting',
  // F-038-c: the engine's own hourly meter sample, the raw events of point 14.
  'meter_reading',
];

const TENANT_TABLES = [...AI_TABLES.map((t) => `ai.${t}`), 'engagement.attention_budget'];

describe('the ai schema, rebuilt per tenant (F-038-a, ADR-0109 point 5)', () => {
  it('has exactly the tables ADR-0109 names, and none of the old ones', () => {
    expect([...models(ai).keys()].sort()).toEqual([...AI_TABLES].sort());
    for (const old of ['user_behavior_event', 'ai_recommendation', 'ai_guardrail_rule', 'ai_guardrail_violation_log']) {
      expect(sql()).toMatch(new RegExp(`DROP TABLE "ai"\\."${old}"`));
    }
  });

  it('speaks no product: the VPN-shaped enums are dropped', () => {
    expect(ai).not.toMatch(/buy_addon_gb|config_expiring_soon|renew_plan/);
    for (const old of ['BehaviorEventType', 'RecommendationType', 'RecommendationStatus', 'GuardrailRuleType', 'GuardrailAction']) {
      expect(sql()).toMatch(new RegExp(`DROP TYPE "ai"\\."${old}"`));
    }
  });

  it('carries the generic action types of point 3', () => {
    const block = /^enum AiActionType\s*\{([\s\S]*?)^\}/m.exec(ai)?.[1] ?? '';
    for (const type of [
      'renew', 'resize_up', 'resize_down', 'top_up_wallet', 'retain_offer', 'trial_convert',
      'checkout_help', 'win_back', 'usage_alert', 'cross_sell', 'wheel_invite', 'referral_invite',
    ]) {
      expect(block).toMatch(new RegExp(`^\\s*${type}\\s*$`, 'm'));
    }
  });

  it.each(TENANT_TABLES)('%s has a NOT NULL tenantId', (table) => {
    const [schema, name] = table.split('.');
    const body = models(schema === 'ai' ? ai : engagement).get(name);
    expect(body).toBeDefined();
    expect(body).toMatch(/^\s*tenantId\s+String\s+(@id\s+)?@db\.Uuid/m);
  });

  it.each(TENANT_TABLES)('%s is strictly isolated by tenant in its first migration', (table) => {
    const [schema, name] = table.split('.');
    const statements = sql();
    expect(statements).toMatch(new RegExp(`ALTER TABLE ${schema}\\.${name} FORCE ROW LEVEL SECURITY`));
    expect(statements).toMatch(
      new RegExp(
        `CREATE POLICY tenant_isolation ON ${schema}\\.${name}[\\s\\S]*?USING \\("tenantId" = public\\.current_tenant_id\\(\\)\\)\\s*WITH CHECK \\("tenantId" = public\\.current_tenant_id\\(\\)\\)`,
      ),
    );
  });

  it('keys the attention budget by subject, and never by a ledger account (C-13)', () => {
    const body = models(engagement).get('attention_budget') ?? '';
    expect(body).toMatch(/@@id\(\[tenantId, subjectKind, subjectId\]\)/);
    expect(body).not.toMatch(/ledger/i);
  });

  it('bounds the holdout share to 5–20% and the threshold to 0–1 (F-1508, F-1503)', () => {
    expect(sql()).toMatch(/"holdoutPercent" BETWEEN 5 AND 20/);
    expect(sql()).toMatch(/"confidenceThreshold" BETWEEN 0 AND 1/);
  });
});
