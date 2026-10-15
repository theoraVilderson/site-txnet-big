import { BotKeys } from '../locale/bot-keys';
import { ACTIONS } from '../flows/views';
import { PAYMENT_CONFIRM_MANUAL } from '../flows/transfer-review.flow';
import { memberMenu, restrictedMenu } from './chat-menu';
import { isRestrictedToken, tokenHolds } from './restricted';

/**
 * BAN-1-g (ADR-0133). A restricted chat signs in, and its menu is the reason
 * and the way to support — nothing a gate would refuse a tap later. The token
 * says so (`restricted: true`); the bot only reads it to pick a menu, the
 * gate is what enforces it.
 */
const token = (claims: object) =>
  ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');

describe('a restricted chat (ADR-0133)', () => {
  it('reads the mark off the token, and nothing else', () => {
    expect(isRestrictedToken(token({ sub: 'u', restricted: true }))).toBe(true);
    expect(isRestrictedToken(token({ sub: 'u' }))).toBe(false);
    expect(isRestrictedToken('not-a-token')).toBe(false);
  });

  it('shows the reason and offers support, accounts and sign-out only', () => {
    const menu = restrictedMenu('unpaid invoice', true);
    expect(menu.body).toEqual({ key: BotKeys.menu.restricted, values: { reason: 'unpaid invoice' } });
    expect(menu.actions.flat().map((a) => a.id)).toEqual([ACTIONS.support, ACTIONS.accounts, ACTIONS.logout]);
  });

  it('says so without a reason, and without a support row where support is not reachable', () => {
    const menu = restrictedMenu(null, false);
    expect(menu.body).toEqual({ key: BotKeys.menu.restrictedNoReason });
    expect(menu.actions.flat().map((a) => a.id)).toEqual([ACTIONS.accounts, ACTIONS.logout]);
  });
});

// F-805-b: the receipts row is for whoever may confirm a transfer by hand — read off the token, never a boundary.
describe('the receipts row (F-805-b)', () => {
  it('reads the key off the token, `*` included, and nothing else', () => {
    expect(tokenHolds(token({ permissions: [PAYMENT_CONFIRM_MANUAL] }), PAYMENT_CONFIRM_MANUAL)).toBe(true);
    expect(tokenHolds(token({ permissions: ['*'] }), PAYMENT_CONFIRM_MANUAL)).toBe(true);
    expect(tokenHolds(token({ permissions: ['user.read'] }), PAYMENT_CONFIRM_MANUAL)).toBe(false);
    expect(tokenHolds(token({ permissions: PAYMENT_CONFIRM_MANUAL }), PAYMENT_CONFIRM_MANUAL)).toBe(false);
    expect(tokenHolds('not-a-token', PAYMENT_CONFIRM_MANUAL)).toBe(false);
  });

  it('is on the member menu only when the chat may use it', () => {
    const ids = (rows: Parameters<typeof memberMenu>[0]) => (memberMenu(rows).actions ?? []).flat().map((a) => a.id);
    expect(ids({ transfers: true })).toContain(ACTIONS.transfers);
    expect(ids({})).not.toContain(ACTIONS.transfers);
  });
});
