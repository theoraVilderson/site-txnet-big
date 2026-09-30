/**
 * Resetting a Grant's subscription link (F-502-p, F-114-e-b): `POST
 * /api/billing/gift/grants/:id/rotate-token`.
 *
 * Three things are the whole route, and all three are silent when wrong:
 *
 *  - **the owner is the gate's user**, never a field. A `userId` a client can
 *    send is a way to rotate somebody else's key, and the refusal it earns
 *    would look identical to an honest one;
 *  - **another user's Grant is answered exactly as a missing one** — one
 *    status, one message. Telling the two apart turns the route into a way to
 *    ask whether a Grant id exists;
 *  - **its own bucket.** Sharing `GIFT_REDEEM`'s would spend the gift box's
 *    deliberately tiny budget on recovering the key that box just handed out.
 */
import { NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { BackendI18nKeys, RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions } from '@txnet-backend/shared-core';

import { GrantTokenController } from './grant-token.controller';

const GRANT = '11111111-1111-4111-8111-111111111111';
const req = (userId: string) => ({ identity: { userId, tenantId: 't-1', roleId: 'r', sessionId: 's', permissions: [] } });

describe('GrantTokenController', () => {
  it('answers the new link, never a bare key, for the id in the path and the user from the gate', async () => {
    const links = { resetOwn: vi.fn(async () => 'https://sub.example.com/sub/sub-key-0001') };
    const controller = new GrantTokenController(links as never);

    const answer = await controller.rotate(GRANT, req('u-1') as never);

    expect(links.resetOwn).toHaveBeenCalledWith(GRANT, 'u-1');
    expect(answer).toEqual({ grantId: GRANT, subscriptionUrl: 'https://sub.example.com/sub/sub-key-0001' });
  });

  it('lets a refusal through as the service raised it: another user’s Grant stays the 404', async () => {
    const notFound = new NotFoundException({ i18nKey: BackendI18nKeys.errors.billing.grant.notFound, reason: 'grant_not_found' });
    const links = { resetOwn: vi.fn(async () => Promise.reject(notFound)) };
    const controller = new GrantTokenController(links as never);

    await expect(controller.rotate(GRANT, req('u-2') as never)).rejects.toBe(notFound);
  });

  it('is a POST on its own bucket, not the gift box’s', () => {
    const handler = GrantTokenController.prototype.rotate;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/rotate-token');
    expect(Reflect.getMetadata(PATH_METADATA, GrantTokenController)).toBe('billing/gift/grants');

    const limit = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions;
    expect(limit.configKey).toBe('GRANT_ROTATE_TOKEN_RATE_LIMIT');
    expect(limit.key(req('u-1') as never)).toBe(`${RateLimitBucket.GRANT_ROTATE_TOKEN}:u-1`);
    expect(limit.key(req('u-1') as never)).not.toContain(RateLimitBucket.GIFT_REDEEM);
  });
});
