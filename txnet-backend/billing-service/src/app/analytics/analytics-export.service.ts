import { Injectable } from '@nestjs/common';
import { BackendI18nKeys, ResellerActor } from '@txnet-backend/shared-core';

import { CATALOG_NAMESPACE } from '../catalog/catalog-texts';
import { LocaleService } from '../locale/locale.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExportFormat, exportBlocks, exportFileName } from './analytics-export';
import { EXPORT_CONTENT_TYPE, toCsv, toXlsx } from './analytics-export-write';
import { AnalyticsService, isReady } from './analytics.service';
import { AnalyticsQuery, AnalyticsTab } from './analytics.schema';

const K = BackendI18nKeys.billing.analyticsExport;
/** Every label the file uses, by field; a field with none is written as itself. */
const LABELS: Readonly<Record<string, string>> = K.labels;
/** A currency the table does not hold: the two places every answer is rounded to. */
const DEFAULT_DECIMALS = 2;
const RTL = 'rtl';

/** A rebuild is running: there are no figures to export (principle 5). */
export class AnalyticsRebuilding extends Error {
  constructor() {
    super('rebuilding');
    this.name = 'AnalyticsRebuilding';
  }
}

export type AnalyticsFile = { fileName: string; contentType: string; body: Buffer };

/** Whether `lang` is written right to left, as `Intl` knows it — no table of languages (C-17). */
function isRtl(lang: string): boolean {
  try {
    const locale = new Intl.Locale(lang) as Intl.Locale & { getTextInfo?: () => { direction?: string } };
    return locale.getTextInfo?.().direction === RTL;
  } catch {
    return false;
  }
}

/**
 * The analytics export (F-1007-a, billing/contract.analytics.md "Export"): a
 * tab's answer as CSV or XLSX. It reads through `AnalyticsService.read`, so the
 * door, the scope, the cache and the under-5 rule are the page's own — this
 * adds the reader's words and nothing else.
 */
@Injectable()
export class AnalyticsExportService {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
    private readonly locale: LocaleService,
  ) {}

  async file(actor: ResellerActor, tenantId: string, tab: AnalyticsTab, q: AnalyticsQuery, format: ExportFormat, lang: string): Promise<AnalyticsFile> {
    const answer = await this.analytics.read(actor, tenantId, tab, q);
    if (!isReady(answer)) throw new AnalyticsRebuilding();

    const text = (namespace: string, key: string) => this.locale.getKey(lang, namespace, key) ?? this.locale.getKey(this.locale.getDefaultLanguage(), namespace, key);
    const productKeys = new Map(answer.names.products.map((p) => [p.id, p.nameKey]));
    const panels = new Map(answer.names.panels.map((p) => [p.id, p.name]));
    const catalogPrefix = `${CATALOG_NAMESPACE}.`;
    const blocks = exportBlocks(answer, {
      label: (field) => (LABELS[field] ? (text('billing', LABELS[field]) ?? field) : field),
      productName: (id) => {
        const key = id ? productKeys.get(id) : undefined;
        return key ? (text(CATALOG_NAMESPACE, key.startsWith(catalogPrefix) ? key.slice(catalogPrefix.length) : key) ?? key) : '';
      },
      panelName: (id) => (id ? (panels.get(id) ?? id) : ''),
      hiddenText: text('billing', K.fewerThan5) ?? K.fewerThan5,
      jalali: q.calendar === 'jalali',
    });

    const decimals = await this.decimalsOf(answer.currencies);
    const body = format === 'csv' ? toCsv(blocks, decimals) : await toXlsx(blocks, { decimals, rtl: isRtl(lang) });
    return { fileName: exportFileName(tab, q.from, q.to, format), contentType: EXPORT_CONTENT_TYPE[format], body };
  }

  /** Each currency's own decimals (C-02), read once per file. `currency.currency` is a shared table, outside RLS. */
  private async decimalsOf(currencies: unknown): Promise<(currency: string) => number> {
    const codes = Array.isArray(currencies) ? currencies.filter((c): c is string => typeof c === 'string') : [];
    const rows = codes.length ? await this.prisma.currency.findMany({ where: { code: { in: codes } }, select: { code: true, decimalPlaces: true } }) : [];
    const byCode = new Map(rows.map((r) => [r.code, r.decimalPlaces]));
    return (currency) => byCode.get(currency) ?? DEFAULT_DECIMALS;
  }
}
