import { SwitchScopeMiddleware } from './switch-scope.middleware';
import { botScopeOf, DEVICE_COOKIE } from './switch-scope';

/**
 * The scope is what keeps one browser's account set out of another's
 * (ADR-0015), and it is decided entirely from things the caller cannot choose:
 * a server-minted cookie, or a header behind a verified service token. These
 * tests pin the two ways that could quietly stop being true — a missing
 * platform silently defaulting, and a browser being handed a fresh identity on
 * every request.
 */
describe('SwitchScopeMiddleware', () => {
  const run = (req: any) => {
    const res: any = { cookie: jest.fn() };
    new SwitchScopeMiddleware().use(req, res, () => undefined);
    return { scope: req.switchScope, res };
  };

  it('reuses the device_id a browser already holds', () => {
    const { scope, res } = run({
      headers: { cookie: `${DEVICE_COOKIE}=abc-123; other=x` },
    });

    expect(scope).toBe('device:abc-123');
    // Re-minting here would give the browser a new identity on every request,
    // and its group would vanish between one page load and the next.
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('mints one, httpOnly, when the browser has none', () => {
    const { scope, res } = run({ headers: {} });

    expect(scope).toMatch(/^device:[0-9a-f-]{36}$/);
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe(DEVICE_COOKIE);
    expect(scope).toBe(`device:${value}`);
    expect(options.httpOnly).toBe(true);
  });

  it('keys a verified bot call on platform AND chat', () => {
    const { scope, res } = run({
      serviceCaller: true,
      headers: { 'x-bot-platform': 'telegram', 'x-bot-chat-id': '900' },
    });

    expect(scope).toBe('bot:telegram:900');
    // A chat is not a browser: no cookie is minted for one.
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('keeps the same chat id on two platforms apart', () => {
    const telegram = run({
      serviceCaller: true,
      headers: { 'x-bot-platform': 'telegram', 'x-bot-chat-id': '900' },
    }).scope;
    const bale = run({
      serviceCaller: true,
      headers: { 'x-bot-platform': 'bale', 'x-bot-chat-id': '900' },
    }).scope;

    // The two platforms number their chats independently, so without the
    // platform in the key these two strangers would share one group.
    expect(telegram).not.toBe(bale);
  });

  it('gives a service caller with no platform header NO scope', () => {
    const { scope } = run({
      serviceCaller: true,
      headers: { 'x-bot-chat-id': '900' },
    });

    // Not a device fallback and not a guessed platform: the routes refuse.
    // Defaulting here would merge Telegram's and Bale's groups silently.
    expect(scope).toBeNull();
  });

  it('gives a service caller naming an unknown platform NO scope', () => {
    const { scope } = run({
      serviceCaller: true,
      headers: { 'x-bot-platform': 'whatsapp', 'x-bot-chat-id': '900' },
    });

    expect(scope).toBeNull();
  });

  it('never reads bot headers from a caller without the service token', () => {
    // The headers alone prove nothing — anyone can send them. Without
    // `serviceCaller` this is a browser, and it gets a browser's scope.
    const { scope } = run({
      headers: { 'x-bot-platform': 'telegram', 'x-bot-chat-id': '900' },
    });

    expect(scope).toMatch(/^device:/);
    expect(botScopeOf({ headers: {} } as any)).toBeNull();
  });
});
