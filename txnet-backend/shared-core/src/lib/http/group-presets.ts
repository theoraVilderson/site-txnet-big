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
 * Only registry keys, none of them `platformOnly` (the spec holds both), so a
 * preset is offered the same way on the platform and on every reseller; what
 * the creator does not hold is dropped in the wizard, with a word why.
 * Texts: `presets.<id>.{label,description}` in the `permissions` namespace.
 */
export type GroupPreset = { id: string; every: boolean; keys: readonly RegistryKey[] };

export const GROUP_PRESETS: readonly GroupPreset[] = [
  { id: 'support', every: false, keys: ['user.read', 'support.agent', 'restriction.assign', 'realtime.tenant.read', 'grant.read', 'grant.repair'] },
  {
    id: 'finance',
    every: false,
    keys: ['user.read', 'report.read', 'payment.confirm_manual', 'wallet.manual_adjust', 'settlement.manage', 'tenant_billing.topup', 'gateway.manage', 'export.request'],
  },
  { id: 'sales', every: false, keys: ['catalog.manage', 'coupon.manage', 'campaign.manage', 'engagement.manage', 'grant.assign', 'report.read'] },
  { id: 'look', every: false, keys: ['theme.manage', 'guide.manage', 'domain.manage', 'bot.manage'] },
  { id: 'admin', every: true, keys: [] },
];
