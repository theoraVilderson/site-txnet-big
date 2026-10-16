import { jalaliOf } from '@txnet-backend/shared-core';

import { FEWER_THAN } from './analytics-figures';

/**
 * The analytics export, part one (F-1007-a, billing/contract.analytics.md
 * "Export"): any tab's answer flattened into blocks — a sheet each in XLSX, a
 * section each in CSV. **By shape, never by tab**, so a later tab gets export
 * by being a tab:
 *
 *  - a KPI (`{value, previous, delta}`), an amount or a lone figure -> a Summary
 *    row, one per currency (principle 6: never a sum across two);
 *  - an object of arrays as long as `buckets` (`series`) -> a block by bucket;
 *  - an array of objects (`byProduct.top`, `calendar`, `products`) -> a block
 *    of its own, a column per field, a currency per column.
 *
 * The answer is already scoped and suppressed (ADR-0104): a hidden cell says
 * `fewer_than_5`, and so does the file — this never reads anything else.
 */

/** What `format=` may ask for (billing "Export"). */
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type Cell = string | number | null;
export type ColumnKind = 'text' | 'count' | 'money' | 'ratio' | 'date';
/** `currency`: the column's own; `currencyAt`: the index of the column holding each row's (Summary). */
export type Column = { header: string; kind: ColumnKind; currency?: string; currencyAt?: number };
export type Block = { name: string; columns: Column[]; rows: Cell[][] };

export type ExportContext = {
  /** A field's words in the reader's language; the field itself when none are written. */
  label: (field: string) => string;
  productName: (id: string | null) => string;
  panelName: (id: string | null) => string;
  /** What a cell under 5 people says. */
  hiddenText: string;
  /** The reader's calendar is Jalali: a Jalali date column beside every Gregorian one. */
  jalali: boolean;
};

/** What every answer carries around its figures — the page's, not the report's (the insights are sentences the page writes from figures the file has). */
const HEAD = new Set(['tab', 'query', 'refreshedAt', 'rebuilding', 'granularity', 'buckets', 'suppressed', 'names', 'currencies', 'insights', 'months']);
/** A field that is a ratio, not a count: written as a percentage. */
const RATIOS = new Set(['share', 'successRate', 'rate', 'delta', 'marginRate', 'previousMarginRate']);
/** A field that names a tenant day. */
const DAYS = new Set(['day', 'bucket', 'cohort']);
/** A per-row sparkline is the page's picture; the file has the series. */
const SKIPPED = new Set(['sparkline']);
/** Summary's currency column; a row without one is a count. */
const SUMMARY_CURRENCY = 1;
/** What a delta from zero says (billing "Read routes"). */
const DELTA_NEW = 'new';

type Json = unknown;
type Obj = Record<string, Json>;

const isObj = (v: Json): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const CURRENCY_RE = /^[A-Z]{3}$/;
/** `{ "USD": "41.25" }` — money per currency, as every answer writes it. */
const isAmounts = (v: Json): v is Record<string, string> => isObj(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k, x]) => CURRENCY_RE.test(k) && typeof x === 'string');
const isKpi = (v: Json): v is { value: Json; previous: Json; delta: Json } => isObj(v) && 'value' in v && 'previous' in v && 'delta' in v;
const num = (v: Json): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** `2026-09-23` -> `1405/07/01`. */
export function jalaliDay(day: string): string {
  const j = jalaliOf(new Date(`${day}T12:00:00Z`));
  return `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`;
}

/** The day columns: the Gregorian day, and the Jalali one for a Jalali reader. */
function dayColumns(ctx: ExportContext, header: string): Column[] {
  return [{ header, kind: 'date' }, ...(ctx.jalali ? [{ header: ctx.label('jalaliDate'), kind: 'text' as const }] : [])];
}
const dayCells = (ctx: ExportContext, day: string): Cell[] => [day, ...(ctx.jalali ? [jalaliDay(day)] : [])];

/** A wrapper whose name says nothing a reader needs: `kpis · net` reads `net`. */
const WRAPPERS = new Set(['kpis']);
const pathLabel = (ctx: ExportContext, path: readonly string[]) =>
  path
    .filter((p) => !WRAPPERS.has(p))
    .map(ctx.label)
    .join(' · ');

/** Summary rows for one figure at `path`: a KPI, an amount, or a lone number. */
function summaryRows(ctx: ExportContext, path: readonly string[], v: Json): Cell[][] | null {
  const metric = pathLabel(ctx, path);
  const delta = (d: Json): Cell => (d === DELTA_NEW ? ctx.label('deltaNew') : num(d));
  if (isKpi(v)) {
    if (isAmounts(v.value)) {
      const before = isObj(v.previous) ? v.previous : {};
      const deltas = isObj(v.delta) ? v.delta : {};
      return Object.entries(v.value).map(([currency, amount]) => [metric, currency, num(amount), num(before[currency]), delta(deltas[currency])]);
    }
    return [[metric, null, num(v.value), num(v.previous), delta(v.delta)]];
  }
  if (isAmounts(v)) return Object.entries(v).map(([currency, amount]) => [metric, currency, num(amount), null, null]);
  if (typeof v === 'number') return [[metric, null, v, null, null]];
  return null;
}

/** One block per series object: a row per bucket, a column per series and currency. */
function seriesBlock(ctx: ExportContext, path: readonly string[], series: Record<string, Json[]>, buckets: readonly string[]): Block {
  const columns: Column[] = dayColumns(ctx, ctx.label('date'));
  const readers: ((i: number) => Cell)[] = [];
  for (const [name, values] of Object.entries(series)) {
    const currencies = [...new Set(values.flatMap((v) => (isAmounts(v) ? Object.keys(v) : [])))];
    if (currencies.length === 0) {
      columns.push({ header: ctx.label(name), kind: 'count' });
      readers.push((i) => num(values[i]));
      continue;
    }
    for (const currency of currencies) {
      columns.push({ header: `${ctx.label(name)} (${currency})`, kind: 'money', currency });
      readers.push((i) => {
        const v = values[i];
        return isAmounts(v) ? num(v[currency]) : null;
      });
    }
  }
  return { name: pathLabel(ctx, path), columns, rows: buckets.map((day, i) => [...dayCells(ctx, day), ...readers.map((read) => read(i))]) };
}

/** A field's column(s) in a table block, and how a row fills them. */
function fieldColumns(ctx: ExportContext, parent: string, field: string, rows: readonly Obj[]): { columns: Column[]; cells: (row: Obj) => Cell[] } {
  const values = rows.map((r) => r[field]);
  const currencies = [...new Set(values.flatMap((v) => (isAmounts(v) ? Object.keys(v) : [])))];
  if (currencies.length > 0) {
    return {
      columns: currencies.map((currency) => ({ header: `${ctx.label(field)} (${currency})`, kind: 'money', currency })),
      cells: (row) => currencies.map((currency) => (isAmounts(row[field]) ? num((row[field] as Record<string, string>)[currency]) : null)),
    };
  }
  const isProduct = field === 'productId' || (field === 'id' && parent === 'products');
  const isPanel = field === 'panelId' || (field === 'id' && parent === 'panels');
  if (isProduct || isPanel) {
    const name = isProduct ? ctx.productName : ctx.panelName;
    return { columns: [{ header: ctx.label(isProduct ? 'product' : 'panel'), kind: 'text' }], cells: (row) => [name((row[field] as string | null) ?? null)] };
  }
  if (DAYS.has(field)) return { columns: dayColumns(ctx, ctx.label(field)), cells: (row) => (typeof row[field] === 'string' ? dayCells(ctx, row[field] as string) : dayColumns(ctx, '').map(() => null)) };
  if (field === 'people') return { columns: [{ header: ctx.label('people'), kind: 'text' }], cells: (row) => [row.people === FEWER_THAN ? ctx.hiddenText : null] };
  const numeric = values.every((v) => v === undefined || v === null || typeof v === 'number');
  const kind: ColumnKind = !numeric ? 'text' : RATIOS.has(field) ? 'ratio' : 'count';
  return { columns: [{ header: ctx.label(field), kind }], cells: (row) => [numeric ? num(row[field]) : row[field] === undefined || row[field] === null ? null : String(row[field])] };
}

/** One block per array of rows; every field any row has, in first-seen order. */
function tableBlock(ctx: ExportContext, path: readonly string[], rows: readonly Obj[]): Block {
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((f) => !SKIPPED.has(f) && !rows.some((r) => Array.isArray(r[f])));
  const parts = fields.map((f) => fieldColumns(ctx, path[path.length - 1] ?? '', f, rows));
  return { name: pathLabel(ctx, path), columns: parts.flatMap((p) => p.columns), rows: rows.map((row) => parts.flatMap((p) => p.cells(row))) };
}

/** Walks one value of the answer, adding Summary rows and blocks as its shape says. */
function walk(ctx: ExportContext, path: string[], v: Json, buckets: readonly string[], out: { summary: Cell[][]; blocks: Block[] }): void {
  const rows = summaryRows(ctx, path, v);
  if (rows) {
    out.summary.push(...rows);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every(isObj)) out.blocks.push(tableBlock(ctx, path, v));
    return;
  }
  if (!isObj(v)) return;
  const entries = Object.entries(v);
  const isCell = (e: Json) => e === null || typeof e === 'number' || isAmounts(e);
  if (entries.length > 0 && entries.every(([, x]) => Array.isArray(x) && x.length === buckets.length && x.every(isCell))) {
    out.blocks.push(seriesBlock(ctx, path, v as Record<string, Json[]>, buckets));
    return;
  }
  for (const [key, x] of entries) walk(ctx, [...path, key], x, buckets, out);
}

/** Every block of a tab's answer, Summary first. */
export function exportBlocks(answer: Obj, ctx: ExportContext): Block[] {
  const buckets = Array.isArray(answer.buckets) ? answer.buckets.filter((b): b is string => typeof b === 'string') : [];
  const out = { summary: [] as Cell[][], blocks: [] as Block[] };
  for (const [key, v] of Object.entries(answer)) if (!HEAD.has(key)) walk(ctx, [key], v, buckets, out);
  const summary: Block = {
    name: ctx.label('summary'),
    columns: [
      { header: ctx.label('metric'), kind: 'text' },
      { header: ctx.label('currency'), kind: 'text' },
      { header: ctx.label('value'), kind: 'money', currencyAt: SUMMARY_CURRENCY },
      { header: ctx.label('previous'), kind: 'money', currencyAt: SUMMARY_CURRENCY },
      { header: ctx.label('delta'), kind: 'ratio' },
    ],
    rows: out.summary,
  };
  return [summary, ...out.blocks];
}

/** `analytics-<tab>-<from>-<to>.<ext>` (billing "Export"). */
export function exportFileName(tab: string, from: string, to: string, format: ExportFormat): string {
  return `analytics-${tab}-${from}-${to}.${format}`;
}
