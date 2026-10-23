import type { Notice } from './user-notifier';

/**
 * The notices about a config's move between servers, told on its Grant. Read
 * at `notifications.retention.*`; `notice-groups.ts` joins them to the
 * templates.
 */
export const CONFIG_NOTIFY_TEMPLATES = ['configMoveReady'] as const;

type ConfigTemplate = (typeof CONFIG_NOTIFY_TEMPLATES)[number];

export const CONFIG_TEMPLATE_TEXT: Record<ConfigTemplate, Notice & { many: Notice }> = {
  // F-1601-d2 (ADR-0160 decision 11): a moved config's replacement is confirmed; the old one keeps working `days` more.
  configMoveReady: {
    read: (ns) => ns?.retention?.configMoveReady,
    fallback: '✅ Your service\'s new config is ready on its new server. If you added the old one to your app by hand, copy the new one from My services; a subscription link updates on its own. The old one keeps working for {{days}} more days.',
    inbox: { read: (ns) => ns?.retention?.configMoveReadyTitle, fallback: 'Your new config is ready' },
    many: {
      read: (ns) => ns?.retention?.configMoveReadyMany,
      fallback: '✅ {{count}} new configs of yours are ready on their new servers. If you added the old ones to your app by hand, copy the new ones from My services; a subscription link updates on its own. The old ones keep working for a few more days.',
      inbox: { read: (ns) => ns?.retention?.configMoveReadyManyTitle, fallback: '{{count}} new configs are ready' },
    },
  },
};
