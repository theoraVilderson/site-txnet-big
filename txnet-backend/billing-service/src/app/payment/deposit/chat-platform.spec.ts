import { describe, expect, it } from 'vitest';
import { chatPlatformOf } from './chat-platform';

const PLATFORM = 'platform-tenant';
const RESELLER = 'reseller-tenant';

describe('chatPlatformOf — whose chat may be offered an in-chat gateway (F-104-k, F-104-q, F-061-j)', () => {
  it('a bot of the payment tenant is its messenger', () => {
    expect(chatPlatformOf({ isBot: true, botPlatform: 'telegram', botTenantId: PLATFORM, gatePlatform: null, tenantId: PLATFORM })).toBe('telegram');
  });

  it('a bot of another tenant is no chat: the owner in their reseller bot pays the platform, so its Stars must not reach the reseller bot', () => {
    expect(chatPlatformOf({ isBot: true, botPlatform: 'telegram', botTenantId: RESELLER, gatePlatform: null, tenantId: PLATFORM })).toBeNull();
  });

  it('a bot that does not name its tenant is no chat', () => {
    expect(chatPlatformOf({ isBot: true, botPlatform: 'telegram', botTenantId: null, gatePlatform: null, tenantId: PLATFORM })).toBeNull();
  });

  it('a bot platform header without the service token is ignored; the gate speaks for a Mini App', () => {
    expect(chatPlatformOf({ isBot: false, botPlatform: 'telegram', botTenantId: PLATFORM, gatePlatform: null, tenantId: PLATFORM })).toBeNull();
    expect(chatPlatformOf({ isBot: false, botPlatform: null, botTenantId: null, gatePlatform: 'bale', tenantId: PLATFORM })).toBe('bale');
  });

  it('a messenger nobody drives is no chat', () => {
    expect(chatPlatformOf({ isBot: true, botPlatform: 'whatsapp', botTenantId: PLATFORM, gatePlatform: null, tenantId: PLATFORM })).toBeNull();
  });
});
