import { BotIntegration } from './bot-integration';

/**
 * A `BotIntegration` for a test, with every field filled in.
 *
 * Exported from the library rather than copied into each spec because three
 * projects now need one — `messenger`, `bot-service` and `auth-service` — and a
 * fixture duplicated three times is a fixture that stops meaning the same
 * thing. Adding a required field to {@link BotIntegration} then breaks here
 * once, not in twenty object literals.
 */
export function aBotIntegration(
  overrides: Partial<BotIntegration> = {},
): BotIntegration {
  return {
    id: 'integration-1',
    tenantId: 'tenant-1',
    platform: 'telegram',
    botUsername: 'txnet_bot',
    webhookPath: 'p'.repeat(43),
    credentialRef: 'integration-1',
    role: 'primary',
    status: 'active',
    ...overrides,
  };
}
