import { Prisma } from '@prisma/client';

import { EXPORT_SKIPS, EXPORT_TABLES, type ExportRule } from './export-tables';

/**
 * The completeness test of catalog §14.8 (F-212-b): every table of every
 * schema is handled by the export — read for the tenant, reached through a
 * parent, or left out for a named reason — and the export names nothing the
 * schema does not have.
 *
 * The schema is Prisma's own model of the database (`Prisma.dmmf`), the same
 * list the migrations are generated against; on 2026-10-22 it held exactly
 * the 221 tables dev's Postgres has. Deletion is not built yet (F-212's other
 * half), so "handled" today means handled by the export.
 */

type Model = { name: string; schema?: string | null; fields: readonly { name: string; kind: string }[] };

/** Every way the table list can disagree with the schema, as one line each; empty when it is complete. */
function exportGaps(models: readonly Model[], rules: Readonly<Record<string, ExportRule>>): string[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const columns = (m: Model) => new Set(m.fields.filter((f) => f.kind !== 'object').map((f) => f.name));
  const gaps: string[] = [];
  for (const m of models) if (!rules[m.name]) gaps.push(`${m.schema}.${m.name}: no export rule`);
  for (const [name, rule] of Object.entries(rules)) {
    const model = byName.get(name);
    if (!model) {
      gaps.push(`${name}: not a table of the schema`);
      continue;
    }
    if (rule.rows === 'none') {
      if (!EXPORT_SKIPS.includes(rule.because)) gaps.push(`${name}: unknown reason ${rule.because}`);
      continue;
    }
    const own = columns(model);
    for (const column of rule.omit ?? []) if (!own.has(column)) gaps.push(`${name}: omits ${column}, which it does not have`);
    const key = rule.rows === 'tenant' ? (rule.column ?? 'tenantId') : rule.column;
    if (!own.has(key)) gaps.push(`${name}: filters on ${key}, which it does not have`);
    gaps.push(...chainGaps(name, rules, byName, columns));
  }
  return gaps;
}

/** A `via` row is the tenant's only if its parent chain ends at a `tenant` rule, through exported tables with an `id`. */
function chainGaps(start: string, rules: Readonly<Record<string, ExportRule>>, byName: Map<string, Model>, columns: (m: Model) => Set<string>): string[] {
  const seen = new Set<string>([start]);
  let rule = rules[start];
  while (rule.rows === 'via') {
    const parent = byName.get(rule.parent);
    const parentRule = rules[rule.parent];
    if (!parent || !parentRule) return [`${start}: parent ${rule.parent} is not a table with a rule`];
    if (!columns(parent).has('id')) return [`${start}: parent ${rule.parent} has no id to reach it by`];
    if (parentRule.rows === 'none') return [`${start}: parent ${rule.parent} is not exported`];
    if (seen.has(rule.parent)) return [`${start}: its parents loop back to ${rule.parent}`];
    seen.add(rule.parent);
    rule = parentRule;
  }
  return [];
}

describe('the data export covers the whole schema (F-212-b)', () => {
  const models = Prisma.dmmf.datamodel.models;

  it('handles every table of every schema, and names no table that is not one', () => {
    expect(exportGaps(models, EXPORT_TABLES)).toEqual([]);
    expect(Object.keys(EXPORT_TABLES)).toHaveLength(models.length);
  });

  it('fails the day a table is added with no decision about it', () => {
    const added: Model = { name: 'ResellerInvoiceNote', schema: 'billing', fields: [{ name: 'id', kind: 'scalar' }, { name: 'tenantId', kind: 'scalar' }] };
    expect(exportGaps([...models, added], EXPORT_TABLES)).toEqual(['billing.ResellerInvoiceNote: no export rule']);
  });

  it('fails on a rule that names a column, a parent or a table the schema does not have', () => {
    const wrong: Record<string, ExportRule> = {
      ...EXPORT_TABLES,
      User: { rows: 'tenant', omit: ['passwordHashV2'] },
      Wallet: { rows: 'via', column: 'ownerUserId', parent: 'OtpCode' },
      Gone: { rows: 'tenant' },
    };
    expect(exportGaps(models, wrong).sort()).toEqual([
      'Gone: not a table of the schema',
      'User: omits passwordHashV2, which it does not have',
      'Wallet: parent OtpCode is not exported',
      'WalletHold: parent OtpCode is not exported',
    ]);
  });

  it('reaches every exported row of a table with no tenant column through its parents', () => {
    const reached = Object.entries(EXPORT_TABLES).filter(([, r]) => r.rows === 'via').map(([name]) => name);
    expect(reached.length).toBeGreaterThan(0);
    for (const name of reached) expect(models.find((m) => m.name === name)?.fields.some((f) => f.name === 'tenantId'), name).toBe(false);
  });
});
