import { BotKeys } from '../locale/bot-keys';
import { ACTIONS, restrictedMenu } from '../flows/views';
import { isRestrictedToken } from './restricted';

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
