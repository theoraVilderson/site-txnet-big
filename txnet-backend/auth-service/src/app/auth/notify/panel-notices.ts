import type { Notice } from './user-notifier';

/**
 * The notices about a panel, told to its owner (F-067-o, F-027-el, F-027-fg):
 * a connection test's verdict, a confirmed change of its health, and a halting
 * drift event. Read at `notifications.panel.*`; `notice-groups.ts` joins
 * them to the templates.
 */
export const PANEL_NOTIFY_TEMPLATES = [
  'panelAccepted',
  'panelRefused',
  'panelDownDns',
  'panelDownPort',
  'panelDownUnreachable',
  'panelDownTls',
  'panelDownPath',
  'panelDownServer',
  'panelLoginRefused',
  'panelRefusingUs',
  'panelRecovered',
  'panelHaltedRestore',
  'panelHaltedDrift',
  'panelHaltedForeign',
  'panelHaltedIdentity',
  'panelHaltedAddress',
] as const;

type PanelTemplate = (typeof PANEL_NOTIFY_TEMPLATES)[number];

/** Several panels paused in one window: each one's reason is on the systems page. */
const HALTED_MANY: Notice = {
  read: (ns) => ns?.panel?.haltedMany,
  fallback: '⏸ {{count}} of your panels were paused and wait for your decision on the systems page.',
  inbox: { read: (ns) => ns?.panel?.haltedManyTitle, fallback: '{{count}} panels paused' },
};

/** A halting drift notice at `panel.<key>` and `panel.<key>Title`, combined into {@link HALTED_MANY}. */
const halted = (key: string, fallback: string, title: string): Notice & { many: Notice } => ({
  read: (ns) => ns?.panel?.[key],
  fallback,
  inbox: { read: (ns) => ns?.panel?.[`${key}Title`], fallback: title },
  many: HALTED_MANY,
});

export const PANEL_TEMPLATE_TEXT: Record<PanelTemplate, Notice & { many: Notice }> = {
  // F-067-o: a connection test's verdict, told to the owner (`accepted_low_trust` is an acceptance).
  panelAccepted: {
    read: (ns) => ns?.panel?.accepted,
    fallback: '✅ Your panel {{panel}} passed its connection test and was accepted.',
    inbox: { read: (ns) => ns?.panel?.acceptedTitle, fallback: 'Panel accepted' },
    many: {
      read: (ns) => ns?.panel?.acceptedMany,
      fallback: '✅ {{count}} of your panels passed their connection test and were accepted.',
      inbox: { read: (ns) => ns?.panel?.acceptedManyTitle, fallback: '{{count}} panels accepted' },
    },
  },
  panelRefused: {
    read: (ns) => ns?.panel?.refused,
    fallback: '❌ Your panel {{panel}} was refused: its connection test showed it cannot report what the platform needs. The details are on the systems page.',
    inbox: { read: (ns) => ns?.panel?.refusedTitle, fallback: 'Panel refused' },
    many: {
      read: (ns) => ns?.panel?.refusedMany,
      fallback: '❌ {{count}} of your panels were refused by their connection test. The details are on the systems page.',
      inbox: { read: (ns) => ns?.panel?.refusedManyTitle, fallback: '{{count}} panels refused' },
    },
  },
  // F-027-el (ADR-0122): a panel's health changed, confirmed — told by what the owner has to fix.
  panelDownDns: {
    read: (ns) => ns?.panel?.downDns,
    fallback: '⚠️ Your panel {{panel}} cannot be reached: its domain no longer resolves. Check the domain\'s DNS record, then the panel\'s address on the systems page.',
    inbox: { read: (ns) => ns?.panel?.downDnsTitle, fallback: 'Panel unreachable: its domain does not resolve' },
    many: {
      read: (ns) => ns?.panel?.downMany,
      fallback: '⚠️ {{count}} of your panels cannot be reached. The reason for each is on the systems page.',
      inbox: { read: (ns) => ns?.panel?.downManyTitle, fallback: '{{count}} panels unreachable' },
    },
  },
  panelDownPort: {
    read: (ns) => ns?.panel?.downPort,
    fallback: '⚠️ Your panel {{panel}} refuses connections on its port. The port may have changed, or the panel\'s service stopped. Check the port in the panel\'s address on the systems page.',
    inbox: { read: (ns) => ns?.panel?.downPortTitle, fallback: 'Panel unreachable: connection refused' },
    many: {
      read: (ns) => ns?.panel?.downMany,
      fallback: '⚠️ {{count}} of your panels cannot be reached. The reason for each is on the systems page.',
      inbox: { read: (ns) => ns?.panel?.downManyTitle, fallback: '{{count}} panels unreachable' },
    },
  },
  panelDownUnreachable: {
    read: (ns) => ns?.panel?.downUnreachable,
    fallback: '⚠️ Your panel {{panel}}\'s server does not answer. It may be off, overloaded, or a firewall may be dropping our connection.',
    inbox: { read: (ns) => ns?.panel?.downUnreachableTitle, fallback: 'Panel unreachable: the server does not answer' },
    many: {
      read: (ns) => ns?.panel?.downMany,
      fallback: '⚠️ {{count}} of your panels cannot be reached. The reason for each is on the systems page.',
      inbox: { read: (ns) => ns?.panel?.downManyTitle, fallback: '{{count}} panels unreachable' },
    },
  },
  panelDownTls: {
    read: (ns) => ns?.panel?.downTls,
    fallback: '⚠️ Your panel {{panel}}\'s secure connection failed: its certificate is invalid, expired or for another name.',
    inbox: { read: (ns) => ns?.panel?.downTlsTitle, fallback: 'Panel unreachable: certificate problem' },
    many: {
      read: (ns) => ns?.panel?.downMany,
      fallback: '⚠️ {{count}} of your panels cannot be reached. The reason for each is on the systems page.',
      inbox: { read: (ns) => ns?.panel?.downManyTitle, fallback: '{{count}} panels unreachable' },
    },
  },
  panelDownPath: {
    read: (ns) => ns?.panel?.downPath,
    fallback: '⚠️ Your panel {{panel}} answers, but not at the address we have: its path has probably changed. Update the panel\'s address on the systems page.',
    inbox: { read: (ns) => ns?.panel?.downPathTitle, fallback: 'Panel unreachable: its address changed' },
    many: {
      read: (ns) => ns?.panel?.downMany,
      fallback: '⚠️ {{count}} of your panels cannot be reached. The reason for each is on the systems page.',
      inbox: { read: (ns) => ns?.panel?.downManyTitle, fallback: '{{count}} panels unreachable' },
    },
  },
  panelDownServer: {
    read: (ns) => ns?.panel?.downServer,
    fallback: '⚠️ Your panel {{panel}} answers with errors. The problem is on the panel itself; check it and its logs.',
    inbox: { read: (ns) => ns?.panel?.downServerTitle, fallback: 'Panel failing' },
    many: {
      read: (ns) => ns?.panel?.downMany,
      fallback: '⚠️ {{count}} of your panels cannot be reached. The reason for each is on the systems page.',
      inbox: { read: (ns) => ns?.panel?.downManyTitle, fallback: '{{count}} panels unreachable' },
    },
  },
  panelLoginRefused: {
    read: (ns) => ns?.panel?.loginRefused,
    fallback: '🔑 Your panel {{panel}} refused our login. If you changed its username or password, enter the new one under the panel\'s settings on the systems page.',
    inbox: { read: (ns) => ns?.panel?.loginRefusedTitle, fallback: 'Panel login refused' },
    many: {
      read: (ns) => ns?.panel?.downMany,
      fallback: '⚠️ {{count}} of your panels cannot be reached. The reason for each is on the systems page.',
      inbox: { read: (ns) => ns?.panel?.downManyTitle, fallback: '{{count}} panels unreachable' },
    },
  },
  panelRefusingUs: {
    read: (ns) => ns?.panel?.refusingUs,
    fallback: '⛔ Your panel {{panel}} is refusing our server\'s requests (blocked or rate limited). Check the panel\'s firewall and its allowed addresses.',
    inbox: { read: (ns) => ns?.panel?.refusingUsTitle, fallback: 'Panel refusing our server' },
    many: {
      read: (ns) => ns?.panel?.downMany,
      fallback: '⚠️ {{count}} of your panels cannot be reached. The reason for each is on the systems page.',
      inbox: { read: (ns) => ns?.panel?.downManyTitle, fallback: '{{count}} panels unreachable' },
    },
  },
  panelRecovered: {
    read: (ns) => ns?.panel?.recovered,
    fallback: '✅ Your panel {{panel}} is reachable again and working.',
    inbox: { read: (ns) => ns?.panel?.recoveredTitle, fallback: 'Panel back online' },
    many: {
      read: (ns) => ns?.panel?.recoveredMany,
      fallback: '✅ {{count}} of your panels are reachable again.',
      inbox: { read: (ns) => ns?.panel?.recoveredManyTitle, fallback: '{{count}} panels back online' },
    },
  },
  // F-027-fg (ADR-0130 decision 5): a halting drift event, told by what the owner has to decide.
  panelHaltedRestore: halted(
    'haltedRestore',
    "⏸ Your panel {{panel}} stopped being read: most of its usage counters went backward at once, as after a backup restore. Its usage is held, not billed, until you acknowledge it on the systems page.",
    'Panel paused: its counters went backward',
  ),
  panelHaltedDrift: halted(
    'haltedDrift',
    '⏸ Your panel {{panel}} stopped being read: many of its users changed on the panel at once. Look at the drift report on the systems page and acknowledge it once you know why.',
    'Panel paused: many users changed',
  ),
  panelHaltedForeign: halted(
    'haltedForeign',
    "⛔ Your panel {{panel}} answers with another panel's users: its address likely points at another server. Nothing is read or changed on it until you put its address right and acknowledge it on the systems page.",
    'Panel paused: it answers as another panel',
  ),
  panelHaltedIdentity: halted(
    'haltedIdentity',
    "⛔ Your panel {{panel}}'s server no longer carries its identity marker: it was reinstalled, or its address points to another server. Nothing is read or created on it until you say which on the systems page.",
    'Panel paused: server not recognised',
  ),
  panelHaltedAddress: halted(
    'haltedAddress',
    "⛔ Your panel {{panel}}'s domain now points to addresses it was not accepted at, so its login was not sent there. If you moved the server, trust the new address on the systems page; if not, fix its DNS.",
    'Panel paused: its address moved',
  ),
};
