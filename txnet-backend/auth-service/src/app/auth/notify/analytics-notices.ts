import type { Notice, NotificationsNamespace } from './user-notifier';

/**
 * The analytics notices, read at `notifications.analytics.*`; `notice-groups.ts`
 * joins them to the templates: a user who costs more than they pay (F-1003),
 * told to each of the tenant's staff once a month per user; and a person's
 * scheduled report (F-1006-a), its figures written by {@link withReportFigures}.
 */
export const ANALYTICS_NOTIFY_TEMPLATES = ['analyticsUserLoss', 'analyticsReport'] as const;

type AnalyticsTemplate = (typeof ANALYTICS_NOTIFY_TEMPLATES)[number];

const REPORT: Notice = {
  read: (ns) => ns?.analytics?.report,
  fallback:
    '📊 {{period}}\n\n💰 Net sales: {{net}} {{currency}}{{netChange}}\n🧾 Orders: {{orders}}{{ordersChange}}\n👥 Buyers: {{buyers}}{{buyersChange}}\n💳 Wallet top-ups: {{topUps}} {{currency}}{{topUpsChange}}{{linkLine}}',
  inbox: { read: (ns) => ns?.analytics?.reportTitle, fallback: 'Your analytics report: {{period}}' },
};

export const ANALYTICS_TEMPLATE_TEXT: Record<AnalyticsTemplate, Notice & { many: Notice }> = {
  // The last 30 days of one user: what they paid and what serving them cost, past the tenant's percent.
  analyticsUserLoss: {
    read: (ns) => ns?.analytics?.userLoss,
    fallback: '📉 {{name}} cost more than they paid in the last 30 days: paid {{net}} {{currencyCode}}, cost {{cost}} {{currencyCode}} (over your {{percent}}% limit). The Profit tab of your analytics has the details.',
    inbox: { read: (ns) => ns?.analytics?.userLossTitle, fallback: 'A user costs more than they pay' },
    many: {
      read: (ns) => ns?.analytics?.userLossMany,
      fallback: '📉 {{count}} users cost more than they paid in the last 30 days. The Profit tab of your analytics lists them.',
      inbox: { read: (ns) => ns?.analytics?.userLossManyTitle, fallback: '{{count}} users cost more than they pay' },
    },
  },
  // A scheduled report: the period's headline figures, each with its change, and a link to the tab. Sent with `only`, so never combined; the summary is there for completeness.
  analyticsReport: {
    ...REPORT,
    many: {
      read: (ns) => ns?.analytics?.reportMany,
      fallback: '📊 {{count}} of your scheduled reports are ready. Your analytics has the figures.',
      inbox: { read: (ns) => ns?.analytics?.reportManyTitle, fallback: '{{count}} analytics reports' },
    },
  },
};

/** A change's words: a percent with its sign, "new" from zero, nothing where nothing was compared. */
function changeOf(delta: string | undefined, percent: Intl.NumberFormat, fresh: string): string {
  if (!delta) return '';
  return ` (${delta === 'new' ? fresh : percent.format(Number(delta))})`;
}

/**
 * A scheduled report's figures in the reader's language (F-1006-a): billing
 * sends them as plain decimals and days; here the period is written in the
 * language's own calendar and digits (`Intl` — a Jalali month for Persian,
 * with no table of languages), the amounts and counts in its digits, each
 * change as a signed percent, and the link as a closing line. Any other
 * template is returned as it came.
 */
export function withReportFigures(template: string, params: Record<string, string>, lang: string, ns: NotificationsNamespace | undefined): Record<string, string> {
  if (template !== 'analyticsReport') return params;
  const day = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' });
  const at = (d: string | undefined) => (d ? day.format(new Date(`${d}T12:00:00Z`)) : '');
  const number = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' });
  const fresh = ns?.analytics?.reportNew ?? 'new';
  const figure = (v: string | undefined) => number.format(Number(v ?? 0));
  const period = params.from === params.to ? at(params.from) : (ns?.analytics?.reportPeriod ?? '{{from}} – {{to}}').replace('{{from}}', at(params.from)).replace('{{to}}', at(params.to));
  const link = params.link ? `\n\n${(ns?.analytics?.reportLink ?? '👉 The details: {{link}}').replace('{{link}}', params.link)}` : '';
  return {
    ...params,
    period,
    net: figure(params.net),
    topUps: figure(params.topUps),
    orders: figure(params.orders),
    buyers: figure(params.buyers),
    netChange: changeOf(params.netDelta, percent, fresh),
    topUpsChange: changeOf(params.topUpsDelta, percent, fresh),
    ordersChange: changeOf(params.ordersDelta, percent, fresh),
    buyersChange: changeOf(params.buyersDelta, percent, fresh),
    linkLine: link,
  };
}
