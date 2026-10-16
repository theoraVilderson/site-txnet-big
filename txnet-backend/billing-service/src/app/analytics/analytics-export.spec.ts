/**
 * The analytics export (F-1007-a, billing/contract.analytics.md "Export"): every
 * tab, as CSV or XLSX, through one exporter.
 *
 * The ways this goes wrong quietly:
 *
 *  - **a hidden cell that comes back as a number.** A product under 5 buyers is
 *    hidden from the platform's staff on the page; the file must say "fewer
 *    than 5" too (ADR-0104), never a figure or a zero;
 *  - **two currencies added together.** Each currency is its own column;
 *  - **a Persian reader's dates in the Gregorian calendar only.** In `jalali`
 *    a Jalali column sits beside the Gregorian one;
 *  - **a new tab that needs exporter code.** A block the exporter has never
 *    seen is exported by its shape — the contract's "adds nothing";
 *  - **a file wrapped as JSON.** The envelope (`{ok, msg, data}`) must let a
 *    `StreamableFile` through, or the download is the stream's JSON;
 *  - **text where Excel needs a number.** Money and counts are numeric cells,
 *    with the currency's decimals; one sheet per block, the header frozen.
 */
import { StreamableFile } from '@nestjs/common';
import { ResponseInterceptor } from '@txnet-backend/shared-core';
import ExcelJS from 'exceljs';
import { lastValueFrom, of } from 'rxjs';

import { exportBlocks, exportFileName } from './analytics-export';
import { toCsv, toXlsx } from './analytics-export-write';

const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const context = (jalali = false) => ({
  label: (field: string) => `L_${field}`,
  productName: (id: string | null) => (id === PRODUCT_A ? 'Gold' : id === PRODUCT_B ? 'Silver' : 'none'),
  panelName: () => 'Frankfurt',
  hiddenText: 'fewer than 5',
  jalali,
});

const answer = {
  tab: 'overview',
  query: { from: '2026-09-22', to: '2026-09-23', compare: 'previous', calendar: 'gregorian' },
  refreshedAt: '2026-09-23T10:00:00.000Z',
  rebuilding: false,
  granularity: 'day',
  buckets: ['2026-09-22', '2026-09-23'],
  suppressed: true,
  names: { products: [], panels: [] },
  currencies: ['IRR', 'USD'],
  kpis: {
    net: { value: { IRR: '1500000.00', USD: '12.50' }, previous: { IRR: '1000000.00', USD: '0.00' }, delta: { IRR: 0.5, USD: 'new' } },
    orders: { value: 3, previous: 2, delta: 0.5 },
    renewal: null,
  },
  series: { salesPackage: [{ IRR: '1000000.00', USD: '2.50' }, null], orders: [2, null] },
  previousSeries: null,
  byProduct: { top: [{ productId: PRODUCT_A, net: { IRR: '1500000.00', USD: '12.50' }, orders: 3, buyers: 9, share: 1 }, { productId: PRODUCT_B, people: 'fewer_than_5' }], other: null },
};

const sheet = (blocks: ReturnType<typeof exportBlocks>, name: string) => {
  const found = blocks.find((b) => b.name === name);
  if (!found) throw new Error(`no block ${name}: ${blocks.map((b) => b.name).join(', ')}`);
  return found;
};
const column = (b: ReturnType<typeof sheet>, header: string) => b.columns.findIndex((c) => c.header === header);

describe('exportBlocks', () => {
  it('puts every KPI in Summary, one row per currency, never one sum across two', () => {
    const summary = sheet(exportBlocks(answer, context()), 'L_summary');
    const rows = summary.rows.filter((r) => r[0] === 'L_net');
    expect(rows.map((r) => [r[1], r[2], r[3]])).toEqual([
      ['IRR', 1500000, 1000000],
      ['USD', 12.5, 0],
    ]);
    expect(summary.rows.find((r) => r[0] === 'L_orders')?.slice(2, 5)).toEqual([3, 2, 0.5]);
  });

  it('says "fewer than 5" for a hidden cell, never a number', () => {
    const top = sheet(exportBlocks(answer, context()), 'L_byProduct · L_top');
    const silver = top.rows.find((r) => r.includes('Silver'));
    expect(silver).toBeDefined();
    expect(silver).toContain('fewer than 5');
    expect(silver?.some((cell) => typeof cell === 'number')).toBe(false);
  });

  it('cuts the series by bucket, a currency per column, a hidden bucket empty', () => {
    const series = sheet(exportBlocks(answer, context()), 'L_series');
    expect(series.columns.map((c) => c.header)).toEqual(['L_date', 'L_salesPackage (IRR)', 'L_salesPackage (USD)', 'L_orders']);
    expect(series.rows).toEqual([
      ['2026-09-22', 1000000, 2.5, 2],
      ['2026-09-23', null, null, null],
    ]);
  });

  it('adds a Jalali date beside the Gregorian one for a Jalali reader (1 Mehr 1405 = 23 September 2026)', () => {
    const series = sheet(exportBlocks(answer, context(true)), 'L_series');
    expect(series.columns.slice(0, 2).map((c) => c.header)).toEqual(['L_date', 'L_jalaliDate']);
    expect(series.rows[1].slice(0, 2)).toEqual(['2026-09-23', '1405/07/01']);
    expect(column(sheet(exportBlocks(answer, context(false)), 'L_series'), 'L_jalaliDate')).toBe(-1);
  });

  it('exports a block it has never seen by its shape — a later tab adds nothing here', () => {
    const later = { ...answer, tab: 'margin', loss: [{ productId: PRODUCT_A, margin: { USD: '-3.25' }, flagged: true }] };
    const block = sheet(exportBlocks(later, context()), 'L_loss');
    expect(block.columns.map((c) => c.header)).toEqual(['L_product', 'L_margin (USD)', 'L_flagged']);
    expect(block.rows).toEqual([['Gold', -3.25, 'true']]);
  });
});

describe('the files', () => {
  it('names the file by tab and window', () => {
    expect(exportFileName('overview', answer.query.from, answer.query.to, 'xlsx')).toBe('analytics-overview-2026-09-22-2026-09-23.xlsx');
  });

  it('writes CSV as one titled section per block, BOM first so Excel reads Persian', () => {
    const csv = toCsv(exportBlocks(answer, context()), () => 2).toString('utf8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('L_series\r\nL_date,L_salesPackage (IRR),L_salesPackage (USD),L_orders\r\n2026-09-22,1000000.00,2.50,2\r\n');
  });

  it('writes XLSX with one sheet per block, the header frozen, money as numbers in the currency decimals', async () => {
    const decimals = (currency: string) => (currency === 'IRR' ? 0 : 2);
    const book = new ExcelJS.Workbook();
    // exceljs reads an ArrayBuffer; a Node Buffer's own type is not one.
    await book.xlsx.load(Uint8Array.from(await toXlsx(exportBlocks(answer, context()), { decimals, rtl: true })).buffer);
    const names = book.worksheets.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(['L_summary', 'L_series']));
    const series = book.getWorksheet('L_series');
    expect(series?.views[0]).toMatchObject({ state: 'frozen', ySplit: 1, rightToLeft: true });
    const irr = series?.getCell('B2');
    expect(irr?.value).toBe(1000000);
    expect(irr?.numFmt).toBe('#,##0');
    expect(series?.getCell('C2').numFmt).toBe('#,##0.00');
  });

  it('leaves a file out of the envelope — the bytes, not their JSON', async () => {
    const file = new StreamableFile(Buffer.from('a,b'));
    const http = { switchToHttp: () => ({ getRequest: () => ({}) }) };
    const out = await lastValueFrom(new ResponseInterceptor({ getKey: () => undefined, getDefaultLanguage: () => 'en' }).intercept(http as never, { handle: () => of(file) }));
    expect(out).toBe(file);
  });
});
