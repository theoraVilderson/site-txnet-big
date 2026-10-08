import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { ResellerBotController } from './reseller-bot.controller';
import type { ResellerBotService } from './reseller-bot.service';

/**
 * The wire shape of `GET /auth/tenants/:tenantId/bots` (F-066-w5,
 * `auth-api/contract.reseller-bots.md`): `{bots:[bot]}`. The route once answered
 * the bare array, and the panel — which reads `.bots`, as the contract says —
 * crashed on its bot screen and on the setup wizard's bot step.
 */
describe('ResellerBotController.list', () => {
  it('answers {bots}, not a bare list', async () => {
    const bot = { platform: 'telegram', botUsername: 'shop_bot' };
    const service = { list: vi.fn(async () => [bot]) } as unknown as ResellerBotService;
    const req = { user: { sub: 'u-1', tenantId: 'p-1', permissions: [] } } as unknown as Request;
    await expect(new ResellerBotController(service).list('11111111-1111-4111-8111-111111111111', req)).resolves.toEqual({ bots: [bot] });
  });
});
