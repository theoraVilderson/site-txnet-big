import { BotKey, BotKeys } from './bot-keys';

/**
 * The last-resort English of My services in the chat (F-307-y).
 * `bot-copy.fallbacks.ts` spreads it into the one table `bot-copy.spec.ts`
 * holds to `bot.json`; it lives apart only to keep that table under the file
 * cap (C-20), as the payment screens' does.
 */
export const SERVICES_FALLBACKS = {
  [BotKeys.action.services]: "🛡 My services",
  [BotKeys.action.servicesBack]: "↩️ My services",
  [BotKeys.services.list]: "🛡 Your services ({{n}}). Pick one to see where it stands.{{more}}",
  [BotKeys.services.more]: "\nYou have {{n}} more — the app shows them all.",
  [BotKeys.services.none]: "You have no services yet.",
  [BotKeys.services.item]: "{{name}} · {{status}}",
  [BotKeys.services.card]: "🛡 {{name}}\nStatus: {{status}}\n{{traffic}}\n{{time}}",
  [BotKeys.services.unnamed]: "Service",
  [BotKeys.services.gone]: "This service is no longer in your list.",
  [BotKeys.services.status.pending]: "Waiting to start",
  [BotKeys.services.status.active]: "Active",
  [BotKeys.services.status.suspended]: "Stopped — out of traffic or credit",
  [BotKeys.services.status.exhausted]: "Out of traffic",
  [BotKeys.services.status.expired]: "Expired",
  [BotKeys.services.status.cancelled]: "Cancelled",
  [BotKeys.services.frozen]: "Frozen",
  [BotKeys.services.traffic.unlimited]: "Traffic: unlimited ({{used}} used)",
  [BotKeys.services.traffic.metered]: "Used: {{used}} — pay as you go",
  [BotKeys.services.traffic.capped]: "Used: {{used}} of {{cap}}",
  [BotKeys.services.traffic.used]: "Used: {{used}}",
  [BotKeys.services.time.left]: "{{d}} days left",
  [BotKeys.services.time.today]: "Less than a day left",
  [BotKeys.services.time.ended]: "Its time is over",
  [BotKeys.services.time.permanent]: "No end date",
} satisfies Partial<Record<BotKey, string>>;
