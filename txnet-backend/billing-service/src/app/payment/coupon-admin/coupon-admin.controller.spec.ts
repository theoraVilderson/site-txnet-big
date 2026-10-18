/**
 * The `/api/billing/coupons` surface (F-502-f, D-33): what reaches the
 * services, and what a refusal looks like on the wire.
 *
 *  - **the permission is the first door.** Without `coupon.manage` nothing is
 *    read at all — and it is only the first: the services keep the tenant;
 *  - **`batches` is never a coupon id.** The literal routes are declared before
 *    `:id`, or `GET /coupons/batches` would be a 400 from the UUID pipe;
 *  - **bodies are strict.** A counter, a deletion stamp or a tenant on an update
 *    is refused, never silently dropped;
 *  - **a refusal keeps its reason** in the body, with a status per reason, so
 *    the panel can translate it;
 *  - **a form learns the currency it writes in** (F-116-h11a) from the same
 *    door as the write, so a coupon seat without `settings.manage` is told it.
 */
import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { COUPON_REFUSAL_STATUS, CouponAdminController } from './coupon-admin.controller';
import { couponCurrencySchema, createCouponSchema, generateBatchSchema, listCouponsSchema, updateCouponSchema } from './coupon-admin.schema';
import { CouponAdminRefused } from './coupon-admin.service';
import { CouponPermissionGuard } from './coupon-permission.guard';

const identity = (permissions: string[]) => ({ userId: 'u-1', tenantId: 't-1', roleId: 'r', sessionId: 's', permissions });
const context = (permissions: string[]) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ identity: identity(permissions) }) }) }) as unknown as ExecutionContext;

describe('CouponPermissionGuard', () => {
  it('refuses a caller without coupon.manage and lets one with it, or with *, through', () => {
    const guard = new CouponPermissionGuard();
    expect(() => guard.canActivate(context(['gateway.manage']))).toThrow(ForbiddenException);
    expect(guard.canActivate(context(['coupon.manage']))).toBe(true);
    expect(guard.canActivate(context(['*']))).toBe(true);
  });
});

describe('CouponAdminController routes', () => {
  it('declares every batches route before the :id routes', () => {
    const proto = CouponAdminController.prototype as unknown as Record<string, unknown>;
    const paths = Object.getOwnPropertyNames(proto)
      .filter((m) => typeof proto[m] === 'function' && Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined)
      .map((m) => String(Reflect.getMetadata(PATH_METADATA, proto[m])));
    const lastBatch = paths.map((p) => p.startsWith('batches') || p === 'currency').lastIndexOf(true);
    const firstId = paths.findIndex((p) => p.startsWith(':id'));
    expect(lastBatch).toBeGreaterThanOrEqual(0);
    expect(firstId).toBeGreaterThan(lastBatch);
  });

  it('answers a refusal with its reason and the status that reason maps to', async () => {
    const coupons = { get: vi.fn(async () => { throw new CouponAdminRefused('coupon_not_found', 'x'); }) };
    const controller = new CouponAdminController(coupons as never, {} as never, {} as never);
    const req = { identity: identity(['coupon.manage']) };
    const err = await controller.get('x', req as never, '10.0.0.1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({ reason: 'coupon_not_found' });
    expect(COUPON_REFUSAL_STATUS.code_taken).toBe(409);
    expect(COUPON_REFUSAL_STATUS.not_platform_owner).toBe(403);
  });

  it('passes the gate’s actor to the service, never one from the body', async () => {
    const coupons = { create: vi.fn(async () => ({ id: 'c' })) };
    const controller = new CouponAdminController(coupons as never, {} as never, {} as never);
    await controller.create({ code: 'ABC', discountType: 'percentage', discountValue: '5' } as never, { identity: identity(['coupon.manage']) } as never, '10.0.0.1');
    expect(coupons.create).toHaveBeenCalledWith({ adminId: 'u-1', tenantId: 't-1', ip: '10.0.0.1' }, expect.objectContaining({ code: 'ABC' }));
  });
});

describe('GET /coupons/currency (F-116-h11a)', () => {
  const req = { identity: identity(['coupon.manage']) } as never;
  const open = (ownerOfNew: (actor: unknown, t: string | null | undefined) => Promise<string | null>) => {
    const coupons = { ownerOfNew: vi.fn(ownerOfNew), access: vi.fn(async () => ({ owner: true })), within: vi.fn(async () => 'EUR') };
    return { coupons, controller: new CouponAdminController(coupons as never, {} as never, {} as never) };
  };

  it("asks whose a new coupon would be — absent the caller's, `platform` the platform's — and answers that owner's code", async () => {
    const { coupons, controller } = open(async (_a, t) => (t === undefined ? 't-1' : (t ?? null)));
    await expect(controller.currency({}, req, '10.0.0.1')).resolves.toEqual({ code: 'EUR' });
    expect(coupons.ownerOfNew).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: 't-1' }), undefined);
    await controller.currency({ tenantId: 'platform' }, req, '10.0.0.1');
    expect(coupons.ownerOfNew).toHaveBeenLastCalledWith(expect.anything(), null);
    const other = '22222222-2222-4222-8222-222222222222';
    await controller.currency({ tenantId: other }, req, '10.0.0.1');
    expect(coupons.ownerOfNew).toHaveBeenLastCalledWith(expect.anything(), other);
  });

  it("refuses a reseller asking for another owner's currency as the write would", async () => {
    const { controller } = open(async () => {
      throw new CouponAdminRefused('not_platform_owner', 'x');
    });
    await expect(controller.currency({ tenantId: 'platform' }, req, '10.0.0.1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('takes a uuid or `platform`, nothing else', () => {
    expect(couponCurrencySchema.safeParse({ tenantId: 'platform' }).success).toBe(true);
    expect(couponCurrencySchema.safeParse({}).success).toBe(true);
    expect(couponCurrencySchema.safeParse({ tenantId: 'mine' }).success).toBe(false);
  });
});

describe('coupon wire schemas', () => {
  it('refuses keys a client might expect to land', () => {
    expect(updateCouponSchema.safeParse({ usedCount: 0 }).success).toBe(false);
    expect(updateCouponSchema.safeParse({ tenantId: null }).success).toBe(false);
    expect(createCouponSchema.safeParse({ code: 'ABC', discountType: 'percentage', discountValue: '5', deletedAt: null }).success).toBe(false);
    expect(createCouponSchema.safeParse({ code: 'ABC', discountType: 'percentage', discountValue: '5', tenantId: null }).success).toBe(true);
  });

  it('bounds money as a decimal string, a batch by size, and a list filter by its names', () => {
    expect(createCouponSchema.safeParse({ code: 'ABC', discountType: 'fixed_amount', discountValue: 5 }).success).toBe(false);
    expect(generateBatchSchema.safeParse({ label: 'x', count: 5001, value: '1' }).success).toBe(false);
    expect(generateBatchSchema.safeParse({ label: 'x', count: 10, value: '1.50' }).success).toBe(true);
    expect(listCouponsSchema.safeParse({ tenantId: 'platform', status: 'active', page: '2' }).data).toMatchObject({ page: 2 });
    expect(listCouponsSchema.safeParse({ status: 'everything' }).success).toBe(false);
  });
});
