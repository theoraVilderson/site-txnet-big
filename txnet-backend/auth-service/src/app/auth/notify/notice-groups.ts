import { ANALYTICS_NOTIFY_TEMPLATES, ANALYTICS_TEMPLATE_TEXT } from './analytics-notices';
import { CONFIG_NOTIFY_TEMPLATES, CONFIG_TEMPLATE_TEXT } from './config-notices';
import { PANEL_NOTIFY_TEMPLATES, PANEL_TEMPLATE_TEXT } from './panel-notices';
import { TRANSFER_NOTIFY_TEMPLATES, TRANSFER_TEMPLATE_TEXT } from './transfer-notices';

/**
 * The notice groups kept in files of their own — a panel's (F-067-o), a
 * transfer's (F-805-b), analytics' (F-1003), a config move's (F-1601-d2) — as
 * one list of names and one text map, so `user-notifier.ts` takes a new group without growing.
 */
export const GROUP_NOTIFY_TEMPLATES = [...PANEL_NOTIFY_TEMPLATES, ...TRANSFER_NOTIFY_TEMPLATES, ...ANALYTICS_NOTIFY_TEMPLATES, ...CONFIG_NOTIFY_TEMPLATES] as const;

export const GROUP_TEMPLATE_TEXT = { ...PANEL_TEMPLATE_TEXT, ...TRANSFER_TEMPLATE_TEXT, ...ANALYTICS_TEMPLATE_TEXT, ...CONFIG_TEMPLATE_TEXT };
