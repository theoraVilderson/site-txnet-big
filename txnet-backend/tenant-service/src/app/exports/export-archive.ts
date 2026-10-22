import { createGzip } from 'node:zlib';

import { Prisma } from '@prisma/client';

import { EXPORT_TABLES, type ExportRule, type ExportSkip } from './export-tables';

/**
 * A tenant's data as one archive (F-212-a, catalog §14.8): gzip JSONL, the
 * format support's monthly archives already use (F-033-n), so `zcat | jq`
 * reads it and no archive library is added.
 *
 * Line 1 is `{"export": …}` — what this is, and what it leaves out and why.
 * Then one `{"table": "<schema>.<table>", "row": {…}}` per row, the row as
 * Postgres's own `to_jsonb` writes it — money as its exact decimal, never a
 * float (C-02). Last, `{"end": {"rows": n, "tables": {…}}}`: a file without
 * it was cut short.
 */

/** The format's name in the header; a change of shape is a new number. */
export const EXPORT_FORMAT = 'txnet-tenant-export/1';

/** Rows read per fetch: bounds what one round trip holds in memory (C-28). */
const FETCH_ROWS = 1000;
const CURSOR = 'tenant_export_rows';

/** One table the archive reads, its SQL already built. */
export type ExportTable = {
  /** `<schema>.<table>`, as the archive names it. */
  name: string;
  /** Database column names dropped from every row (secrets, `omit`). */
  omit: string[];
  /** `SELECT <row as JSON text> AS line …` for this tenant. */
  query: Prisma.Sql;
};

export type ExportPlan = {
  tables: ExportTable[];
  /** `<schema>.<table>` -> why it is not in the archive. */
  skipped: Record<string, ExportSkip>;
};

type Model = Prisma.DMMF.Model;
const MODELS = new Map<string, Model>(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** A model by name; the spec holds that every name in the table list is one. */
export function modelOf(name: string): Model {
  const model = MODELS.get(name);
  if (!model) throw new Error(`no Prisma model ${name}`);
  return model;
}

/** `<schema>.<table>` of a model. */
export function tableNameOf(model: Model): string {
  return `${model.schema ?? 'public'}.${model.dbName ?? model.name}`;
}

/** The database column a model's field is stored in. */
export function columnOf(model: Model, field: string): string {
  const found = model.fields.find((f) => f.name === field && f.kind !== 'object');
  if (!found) throw new Error(`${model.name} has no column ${field}`);
  return found.dbName ?? found.name;
}

const tableSql = (model: Model) => Prisma.raw(`${quote(model.schema ?? 'public')}.${quote(model.dbName ?? model.name)}`);

/**
 * The predicate that picks this tenant's rows of `model` under the alias
 * `alias`: its own column, or a parent's row through the parent's `id`. Every
 * id is a parameter; every identifier comes from the schema, never from input.
 */
function rowsOf(model: Model, rule: ExportRule, tenantId: string, depth: number): Prisma.Sql {
  const alias = `t${depth}`;
  if (rule.rows === 'tenant') {
    return Prisma.sql`${Prisma.raw(`${alias}.${quote(columnOf(model, rule.column ?? 'tenantId'))}`)} = ${tenantId}::uuid`;
  }
  if (rule.rows === 'none') throw new Error(`${model.name} is not exported, so nothing is reached through it`);
  const parent = modelOf(rule.parent);
  const inner = `t${depth + 1}`;
  return Prisma.sql`${Prisma.raw(`${alias}.${quote(columnOf(model, rule.column))}`)} IN (
    SELECT ${Prisma.raw(`${inner}.${quote(columnOf(parent, 'id'))}`)} FROM ${tableSql(parent)} ${Prisma.raw(inner)}
     WHERE ${rowsOf(parent, EXPORT_TABLES[rule.parent], tenantId, depth + 1)})`;
}

/** What the archive of `tenantId` reads, table by table, in a stable order. */
export function exportPlan(tenantId: string): ExportPlan {
  const tables: ExportTable[] = [];
  const skipped: Record<string, ExportSkip> = {};
  const names = Object.keys(EXPORT_TABLES).sort() as Prisma.ModelName[];
  for (const name of names) {
    const rule = EXPORT_TABLES[name];
    const model = modelOf(name);
    if (rule.rows === 'none') {
      skipped[tableNameOf(model)] = rule.because;
      continue;
    }
    const omit = (rule.omit ?? []).map((field) => columnOf(model, field));
    const query = Prisma.sql`SELECT (to_jsonb(t0) - ${omit}::text[])::text AS line FROM ${tableSql(model)} t0 WHERE ${rowsOf(model, rule, tenantId, 0)}`;
    tables.push({ name: tableNameOf(model), omit, query });
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
  return { tables, skipped };
}

/** Where rows come from: pages of each table's rows, each row already JSON text. */
export interface ExportRowSource {
  pages(table: ExportTable): AsyncIterable<string[]>;
}

/**
 * Rows through a cursor in the caller's transaction (C-41: it closes with the
 * transaction), so a big table is read a page at a time inside one snapshot.
 */
export class SqlExportRows implements ExportRowSource {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async *pages(table: ExportTable): AsyncIterable<string[]> {
    await this.tx.$executeRaw(Prisma.sql`DECLARE ${Prisma.raw(CURSOR)} NO SCROLL CURSOR FOR ${table.query}`);
    try {
      for (;;) {
        const page = await this.tx.$queryRaw<{ line: string }[]>(Prisma.sql`FETCH ${Prisma.raw(String(FETCH_ROWS))} FROM ${Prisma.raw(CURSOR)}`);
        if (page.length === 0) return;
        yield page.map((r) => r.line);
      }
    } finally {
      await this.tx.$executeRaw(Prisma.sql`CLOSE ${Prisma.raw(CURSOR)}`);
    }
  }
}

export type ExportHeader = { exportId: string; tenantId: string; createdAt: Date };

export type BuiltArchive = { bytes: Buffer; rowCount: number; tables: Record<string, number> };

/** The archive of one plan, gzip-compressed as it is written so only the compressed bytes are held. */
export async function writeArchive(source: ExportRowSource, plan: ExportPlan, header: ExportHeader): Promise<BuiltArchive> {
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });
  const write = async (line: string) => {
    if (!gzip.write(`${line}\n`)) await new Promise<void>((resolve) => gzip.once('drain', resolve));
  };

  const omittedColumns = Object.fromEntries(plan.tables.filter((t) => t.omit.length > 0).map((t) => [t.name, t.omit]));
  await write(JSON.stringify({ export: { format: EXPORT_FORMAT, ...header, createdAt: header.createdAt.toISOString(), omittedColumns, skipped: plan.skipped } }));
  const tables: Record<string, number> = {};
  let rowCount = 0;
  for (const table of plan.tables) {
    const prefix = `{"table":${JSON.stringify(table.name)},"row":`;
    let count = 0;
    for await (const page of source.pages(table)) {
      for (const row of page) await write(`${prefix}${row}}`);
      count += page.length;
    }
    tables[table.name] = count;
    rowCount += count;
  }
  await write(JSON.stringify({ end: { rows: rowCount, tables } }));
  gzip.end();
  await ended;
  return { bytes: Buffer.concat(chunks), rowCount, tables };
}
