import type { Notice } from './user-notifier';

/**
 * The notice about a user who costs more than they pay (F-1003), told to each
 * of the tenant's staff once a month per user. Read at
 * `notifications.analytics.*`; `notice-groups.ts` joins it to the templates.
 */
export const ANALYTICS_NOTIFY_TEMPLATES = ['analyticsUserLoss'] as const;

type AnalyticsTemplate = (typeof ANALYTICS_NOTIFY_TEMPLATES)[number];

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
};
