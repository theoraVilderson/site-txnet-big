import ExcelJS from 'exceljs';

import type { Block, Cell, Column, ExportFormat } from './analytics-export';

/**
 * The analytics export, part two (F-1007-a): blocks written as a file. XLSX
 * has a sheet per block, the header frozen, money and counts as numbers —
 * money in its currency's decimals — and dates as dates; CSV has a titled
 * section per block, UTF-8 with a BOM so Excel reads Persian.
 */

export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Excel's rules for a sheet name: at most 31 characters, none of `\ / ? * [ ] :`. */
const SHEET_NAME_MAX = 31;
const SHEET_NAME_FORBIDDEN = /[\\/?*[\]:]/g;
/** Wide enough for a date or a Persian product name; Excel has no auto-fit on write. */
const COLUMN_WIDTH = 18;
const BOM = '\uFEFF';
const CRLF = '\r\n';
/** A text cell a spreadsheet would run as a formula (CSV injection): written with a leading quote. */
const FORMULA_START = /^[=+\-@\t\r]/;

const currencyOf = (column: Column, row: readonly Cell[]): string | null => column.currency ?? (column.currencyAt !== undefined ? ((row[column.currencyAt] as string | null) ?? null) : null);

/** `#,##0` or `#,##0.00…`, the currency's decimals. */
const moneyFormat = (decimals: number) => (decimals > 0 ? `#,##0.${'0'.repeat(decimals)}` : '#,##0');

function csvCell(column: Column, row: readonly Cell[], value: Cell, decimals: (currency: string) => number): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    const currency = column.kind === 'money' ? currencyOf(column, row) : null;
    return currency ? value.toFixed(decimals(currency)) : String(value);
  }
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One titled section per block, a blank line between them. */
export function toCsv(blocks: readonly Block[], decimals: (currency: string) => number): Buffer {
  const lines: string[] = [];
  for (const block of blocks) {
    if (lines.length) lines.push('');
    lines.push(csvCell({ header: '', kind: 'text' }, [], block.name, decimals));
    lines.push(block.columns.map((c) => csvCell({ header: '', kind: 'text' }, [], c.header, decimals)).join(','));
    for (const row of block.rows) lines.push(block.columns.map((c, i) => csvCell(c, row, row[i] ?? null, decimals)).join(','));
  }
  return Buffer.from(BOM + lines.join(CRLF) + CRLF, 'utf8');
}

/** A sheet name Excel accepts, unique in the book. */
function sheetName(name: string, taken: Set<string>): string {
  const base = name.replace(SHEET_NAME_FORBIDDEN, ' ').trim().slice(0, SHEET_NAME_MAX) || 'Sheet';
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base.slice(0, SHEET_NAME_MAX - String(n).length - 1)} ${n}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function xlsxCell(cell: ExcelJS.Cell, column: Column, row: readonly Cell[], value: Cell, decimals: (currency: string) => number): void {
  if (value === null) return;
  if (column.kind === 'date' && typeof value === 'string') {
    cell.value = new Date(`${value}T00:00:00Z`);
    cell.numFmt = 'yyyy-mm-dd';
    return;
  }
  cell.value = value;
  if (typeof value !== 'number') return;
  const currency = column.kind === 'money' ? currencyOf(column, row) : null;
  if (currency) cell.numFmt = moneyFormat(decimals(currency));
  else if (column.kind === 'ratio') cell.numFmt = '0.00%';
}

/** One sheet per block, its header bold and frozen; right to left for a right-to-left reader. */
export async function toXlsx(blocks: readonly Block[], how: { decimals: (currency: string) => number; rtl: boolean }): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const taken = new Set<string>();
  for (const block of blocks) {
    const sheet = book.addWorksheet(sheetName(block.name, taken), { views: [{ state: 'frozen', ySplit: 1, rightToLeft: how.rtl }] });
    sheet.columns = block.columns.map((c) => ({ header: c.header, width: COLUMN_WIDTH }));
    sheet.getRow(1).font = { bold: true };
    block.rows.forEach((row, r) => {
      const line = sheet.getRow(r + 2);
      block.columns.forEach((column, c) => xlsxCell(line.getCell(c + 1), column, row, row[c] ?? null, how.decimals));
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
