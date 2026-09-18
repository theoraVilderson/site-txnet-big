import { describe, expect, it } from 'vitest';
import { ChatCaller, chatOf } from './chat-platform';

const PLATFORM = 'platform-tenant';
const RESELLER = 'reseller-tenant';

const caller = (overrides: Partial<ChatCaller> = {}): ChatCaller => ({
  isBot: true,
  botPlatform: 'telegram',
  botTenantId: PLATFORM,
  gatePlatform: 'telegram',
  gateChatId: '42',
  tenantId: PLATFORM,
  ...overrides,
});

describe('chatOf — whose chat may be offered an in-chat gateway (F-104-k, F-104-q, F-061-j, F-104-ab)', () => {
  it('a bot of the payment tenant is its messenger, and the gate names the payer in it', () => {
    expect(chatOf(caller())).toEqual({ platform: 'telegram', payerId: '42' });
  });

  it('a bot of another tenant is no chat: the owner in their reseller bot pays the platform, so its Stars must not reach the reseller bot', () => {
    expect(chatOf(caller({ botTenantId: RESELLER }))).toBeNull();
  });

  it('a bot that does not name its tenant is no chat', () => {
    expect(chatOf(caller({ botTenantId: null }))).toBeNull();
  });

  it('a bot platform header without the service token is ignored; the gate speaks for a Mini App', () => {
    expect(chatOf(caller({ isBot: false, gatePlatform: null, gateChatId: null }))).toBeNull();
    expect(chatOf(caller({ isBot: false, botPlatform: null, botTenantId: null, gatePlatform: 'bale', gateChatId: '-7' }))).toEqual({
      platform: 'bale',
      payerId: '-7',
    });
  });

  it('a messenger nobody drives is no chat', () => {
    expect(chatOf(caller({ botPlatform: 'whatsapp', gatePlatform: 'whatsapp' }))).toBeNull();
  });

  it('no chat without a payer the gate named in the same messenger: its events could not be matched to anyone (F-104-ab)', () => {
    expect(chatOf(caller({ gateChatId: null }))).toBeNull();
    expect(chatOf(caller({ gatePlatform: null }))).toBeNull();
    expect(chatOf(caller({ gatePlatform: 'bale' }))).toBeNull();
  });
});
