import type { PERMISSION_REGISTRY } from './permission-registry.generated';

/** A key the policy file names — a preset can spell no other. */
type RegistryKey = (typeof PERMISSION_REGISTRY)[number]['permission'];

/**
 * A starting point for a new group (GR-1-h, user 2026-10-10): a name and the
 * keys it suggests. A template only — nothing is ever created from it but the
 * group a person finishes in the wizard, so changing a preset touches no group
 * that exists. `every` is the admin preset: every key the creator may give,
 * resolved where `grantable` is known, never written down here.
 *
 * `keys` are registry keys, none of them `platformOnly` (the spec holds both),
 * so they are offered the same way on the platform and on every reseller; what
 * the creator does not hold is dropped in the wizard, with a word why.
 * `platformKeys` are platform-only keys the wizard adds on the platform's own
 * groups alone (GR-1-s): Support's `platform.support`, its work in resellers
 * under their consent (ADR-0141). A reseller's wizard never sees them.
 * Texts: `presets.<id>.{label,description}` in the `permissions` namespace.
 */
export type GroupPreset = { id: string; every: boolean; keys: readonly RegistryKey[]; platformKeys?: readonly RegistryKey[] };

export const GROUP_PRESETS: readonly GroupPreset[] = [
  {
    id: 'support',
    every: false,
    // `user.write`: edit the person's details, and block or unblock them (GR-1-t).
    keys: ['user.read', 'user.write', 'support.agent', 'restriction.assign', 'realtime.tenant.read', 'grant.read', 'grant.repair', 'grant.compensate'],
    platformKeys: ['platform.support'],
  },
  {
    id: 'finance',
    every: false,
    // `user_group.read`: aim a gateway at a group of customers (ADR-0143).
    keys: ['user.read', 'report.read', 'analytics.read', 'payment.confirm_manual', 'wallet.manual_adjust', 'settlement.manage', 'tenant_billing.topup', 'gateway.manage', 'export.request', 'user_group.read'],
  },
  // `user_group.read`: aim a product, discount, lottery, wheel or campaign at a group of customers (ADR-0143).
  { id: 'sales', every: false, keys: ['catalog.manage', 'coupon.manage', 'campaign.manage', 'engagement.manage', 'grant.assign', 'report.read', 'analytics.read', 'user_group.read'] },
  { id: 'look', every: false, keys: ['theme.manage', 'guide.manage', 'domain.manage', 'bot.manage'] },
  { id: 'admin', every: true, keys: [] },
];
