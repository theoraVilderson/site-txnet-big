/**
 * The dev stack's billing-service would not boot (2026-09-29): Nest could not
 * resolve `BlockPurchaseService`'s third argument, printed as `?`. The type
 * was `undefined` when the decorator ran, because `vpn-reserve.ts` reached
 * `block-purchase.ts` through a cycle — `vpn-postpaid` -> `postpaid-hold` ->
 * `spending-cap` -> `revival` -> `exhaustion` — before its own class existed.
 * `WalletModule` loads `vpn-reserve.ts` first, as this spec does.
 *
 * The cap engine the money paths call (`withinCap`, `spendOnCap`) lives in
 * `usage/cap-funding.ts`, which imports nothing that reaches back here.
 */
import 'reflect-metadata';

describe('the VPN reserve loads before anything that injects it', () => {
  it('gives BlockPurchaseService a defined VpnReserve, loading vpn-reserve first', async () => {
    const { VpnReserve } = await import('./vpn-reserve');
    const { BlockPurchaseService } = await import('./block-purchase');
    const params = Reflect.getMetadata('design:paramtypes', BlockPurchaseService) as unknown[];
    expect(params[2]).toBe(VpnReserve);
  });
});
