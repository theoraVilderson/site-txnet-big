import { returnBotLinkOf } from './deposit-return';

/**
 * F-093-u: the link back to the bot a top-up started in. It becomes a button
 * on the panel's result page, so only an https link of a sane length is kept;
 * only the bot (behind the service token) is asked for it at all.
 */
describe('returnBotLinkOf', () => {
  it('keeps the https link the bot sent', () => {
    expect(returnBotLinkOf('https://t.me/txnet_bot?start=paid')).toBe('https://t.me/txnet_bot?start=paid');
  });

  it.each([
    ['nothing', undefined],
    ['not a url', 'txnet_bot'],
    ['not https', 'http://t.me/txnet_bot'],
    ['a script', 'javascript:alert(1)'],
    ['too long', `https://t.me/${'a'.repeat(300)}`],
  ])('drops %s', (_case, raw) => {
    expect(returnBotLinkOf(raw)).toBeNull();
  });
});
