import { describe, expect, it } from 'vitest';
import { resolveWebhookBase, WEBHOOK_DOOR } from './webhook-address';
import { BOT_PLATFORMS } from './bot-platform';

/**
 * Where a messenger calls a bot back (NIN-1-d3, ADR-0165 point 2): Bale's
 * servers are inside Iran, so its webhook is on the domestic domain, which a
 * cut leaves reachable; Telegram's are abroad and reach the Cloudflare door.
 */
const env = (vars: Record<string, string>) => (key: string) => vars[key];
const BOTH = { DOMAIN_NAME: 'alpha.app', DOMESTIC_DOMAIN_NAME: 'zeta.ir' };

describe('resolveWebhookBase', () => {
  it("builds Bale's on the domestic domain and Telegram's on DOMAIN_NAME", () => {
    expect(resolveWebhookBase(env(BOTH), 'bale')).toBe('https://api.zeta.ir');
    expect(resolveWebhookBase(env(BOTH), 'telegram')).toBe('https://api.alpha.app');
  });

  it('builds both on DOMAIN_NAME when no domestic domain is set', () => {
    expect(resolveWebhookBase(env({ DOMAIN_NAME: 'alpha.app' }), 'bale')).toBe('https://api.alpha.app');
  });

  it('keeps an explicit base first, per platform and then shared', () => {
    expect(resolveWebhookBase(env({ ...BOTH, BALE_WEBHOOK_PUBLIC_BASE: 'https://relay.example/' }), 'bale')).toBe(
      'https://relay.example',
    );
    expect(resolveWebhookBase(env({ ...BOTH, BOT_WEBHOOK_PUBLIC_BASE: 'https://tunnel.example' }), 'bale')).toBe(
      'https://tunnel.example',
    );
    expect(resolveWebhookBase(env({}), 'bale')).toBeNull();
  });

  it('names a door for every platform', () => {
    expect(Object.keys(WEBHOOK_DOOR).sort()).toEqual([...BOT_PLATFORMS].sort());
  });
});
