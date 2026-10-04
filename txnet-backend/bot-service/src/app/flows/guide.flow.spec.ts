import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import type { GuideBlock } from '@txnet-backend/shared-core';
import { ChatContext } from '../conversation/nav.types';
import { BotGuide, GuideApiClient } from '../guide-api/guide-api.client';
import { GuideMediaSender } from '../guide-api/guide-media.sender';
import { BotKeys } from '../locale/bot-keys';
import { RedisKeys } from '../redis/redis.keys';
import { GUIDE_KEY_PREFIX, GUIDE_OS_PREFIX, GUIDE_TEXT_MAX, GuideFlow, guideMedia, guidePlainText } from './guide.flow';
import { ACTIONS } from './views';

/**
 * Guides in the chat (F-414-f): the panel's resolver over tenant-service's
 * internal route, for the bot's own tenant. What breaks with nothing red anywhere:
 *  - **another tenant's guides** — the tenant is the integration's, never a
 *    message's; a guest reads them too, as on a public panel page;
 *  - **a button the platform drops** — callback data over 64 bytes is refused
 *    by Telegram, and a 60-character key is legal;
 *  - **HTML or a script link from a reseller's Markdown** — the renderer
 *    escapes, so the text arrives flat: bullets, `label (url)`, no markers;
 *  - **a 30 MB video uploaded on every tap** — a platform's `file_id` is kept
 *    per bot and file, and sent instead of the bytes.
 */
const integration = aBotIntegration({ id: 'integration-1', tenantId: 'tenant-1' });
const ctx: ChatContext = { integration, platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const T = '11111111-1111-4111-8111-111111111111';
const file = (name: string) => `tenants/${T}/guides/g/${name}`;

const guide = (over: Partial<BotGuide> = {}): BotGuide => ({
  key: 'v2rayng',
  kind: 'app',
  lang: 'fa',
  title: 'v2rayNG',
  blocks: [{ type: 'text', text: 'Install it.' }],
  ...over,
});

function harness(o: { slot?: BotGuide[] | null; one?: BotGuide | null | undefined } = {}) {
  const api = {
    isConfigured: true,
    forSlot: vi.fn().mockResolvedValue(o.slot === null ? { ok: false } : { ok: true, guides: o.slot ?? [guide()] }),
    one: vi.fn().mockResolvedValue(o.one === undefined ? { ok: true, guide: guide() } : o.one === null ? { ok: true, guide: null } : { ok: true, guide: o.one }),
  } as unknown as Mocked<GuideApiClient>;
  return { api, flow: new GuideFlow(api) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);

describe('GuideFlow', () => {
  it("opens on the main menu's guides, for this bot's tenant, with the install guide first", async () => {
    const { flow, api } = harness({ slot: [guide({ key: 'start_here', title: 'Start here' })] });
    const r = await flow.start(ctx);
    expect(api.forSlot).toHaveBeenCalledWith('tenant-1', 'bot_screen', 'main_menu', 'fa');
    expect(ids(r)).toEqual([ACTIONS.guidesInstall, `${GUIDE_KEY_PREFIX}start_here`]);
    expect(r.view.body.key).toBe(BotKeys.guides.menu);
  });

  it('asks for a system, then lists that system’s guides as its apps', async () => {
    const { flow, api } = harness({ slot: [guide(), guide({ key: 'hiddify', title: 'Hiddify' })] });
    expect(ids(flow.install())).toEqual(['android', 'ios', 'windows', 'macos', 'linux'].map((os) => `${GUIDE_OS_PREFIX}${os}`));
    const r = await flow.tap(ctx, `${GUIDE_OS_PREFIX}android`);
    expect(api.forSlot).toHaveBeenCalledWith('tenant-1', 'os', 'android', 'fa');
    expect(ids(r)).toEqual([`${GUIDE_KEY_PREFIX}v2rayng`, `${GUIDE_KEY_PREFIX}hiddify`]);
    expect(r.view.body.key).toBe(BotKeys.guides.pickApp);
  });

  it('says so when a system has no guide, and when the reader cannot be reached', async () => {
    expect((await harness({ slot: [] }).flow.tap(ctx, `${GUIDE_OS_PREFIX}ios`)).view.body.key).toBe(BotKeys.guides.noneForOs);
    expect((await harness({ slot: null }).flow.tap(ctx, `${GUIDE_OS_PREFIX}ios`)).view.body.key).toBe(BotKeys.guides.failed);
    expect((await harness({ slot: null }).flow.tap(ctx, `${GUIDE_OS_PREFIX}beos`)).view.body.key).toBe(BotKeys.guides.failed);
  });

  it('keeps every button within the 64 bytes a platform carries', async () => {
    const longKey = 'k'.repeat(60);
    const r = await harness({ slot: [guide({ key: longKey })] }).flow.start(ctx);
    for (const id of ids(r)) expect(Buffer.byteLength(id)).toBeLessThanOrEqual(64);
  });

  it('shows a guide as its title and flat text, and sends its pictures and video after it, in order', async () => {
    const blocks: GuideBlock[] = [
      { type: 'text', text: '## Steps\n- open **the app**\n- tap [here](https://x.test/a)' },
      { type: 'image', file: file('a.png'), alt: 'The home screen', caption: 'Home' },
      { type: 'video', file: file('v.mp4'), poster: file('p.jpg'), caption: 'Watch' },
      { type: 'steps', items: [{ text: 'One', image: file('s.png') }, { text: 'Two' }] },
      { type: 'callout', tone: 'warning', title: 'Note', text: 'Keep it on.' },
    ];
    const { flow, api } = harness({ one: guide({ title: 'v2rayNG', blocks }) });
    const r = await flow.tap(ctx, `${GUIDE_KEY_PREFIX}v2rayng`);
    expect(api.one).toHaveBeenCalledWith('tenant-1', 'v2rayng', 'fa');
    expect(r.view.body).toEqual({ key: BotKeys.guides.screen, values: { title: { raw: 'v2rayNG' }, text: { raw: guidePlainText(blocks) } } });
    expect(guidePlainText(blocks)).toBe('Steps\n• open the app\n• tap here (https://x.test/a)\n\n1. One\n2. Two\n\n⚠️ Note\nKeep it on.');
    expect(r.media).toEqual([
      { kind: 'photo', key: file('a.png'), caption: 'Home' },
      { kind: 'video', key: file('v.mp4'), caption: 'Watch' },
      { kind: 'photo', key: file('s.png'), caption: '1' },
    ]);
  });

  it('leaves a script link and a tag as text', () => {
    expect(guidePlainText([{ type: 'text', text: '[x](javascript:alert(1)) <b>y</b>' }])).toBe('[x](javascript:alert(1)) <b>y</b>');
  });

  it('cuts a long guide at a fixed length rather than letting the platform refuse it', () => {
    const text = guidePlainText([{ type: 'text', text: 'word '.repeat(2000) }]);
    expect(text.length).toBeLessThanOrEqual(GUIDE_TEXT_MAX);
    expect(text.endsWith('…')).toBe(true);
  });

  it('says a guide is gone when the tenant no longer sees it', async () => {
    expect((await harness({ one: null }).flow.tap(ctx, `${GUIDE_KEY_PREFIX}gone`)).view.body.key).toBe(BotKeys.guides.gone);
  });

  it('sends nothing for a guide with no pictures', () => {
    expect(guideMedia([{ type: 'text', text: 'a' }])).toEqual([]);
  });
});

describe('GuideMediaSender', () => {
  const key = file('v.mp4');

  function sender(cached: string | null) {
    const redis = { get: vi.fn().mockResolvedValue(cached), set: vi.fn().mockResolvedValue(undefined) };
    const fetchBytes = vi.fn().mockResolvedValue({ bytes: Buffer.from('mp4'), contentType: 'video/mp4' });
    const client = { sendMedia: vi.fn().mockResolvedValue('file-id-9') };
    const s = new GuideMediaSender(redis as never, fetchBytes);
    return { s, redis, fetchBytes, client };
  }

  it('uploads a file once, then sends the platform’s own id for it', async () => {
    const first = sender(null);
    await first.s.send(first.client as never, integration, '5501', [{ kind: 'video', key, caption: 'Watch' }]);
    expect(first.fetchBytes).toHaveBeenCalledWith(key);
    expect(first.client.sendMedia).toHaveBeenCalledWith('5501', 'video', { fileName: 'v.mp4', contentType: 'video/mp4', bytes: Buffer.from('mp4') }, 'Watch');
    expect(first.redis.set).toHaveBeenCalledWith(RedisKeys.botGuideFile(integration, key), 'file-id-9', expect.any(Number));

    const again = sender('file-id-9');
    await again.s.send(again.client as never, integration, '5501', [{ kind: 'video', key }]);
    expect(again.fetchBytes).not.toHaveBeenCalled();
    expect(again.client.sendMedia).toHaveBeenCalledWith('5501', 'video', { fileId: 'file-id-9' }, undefined);
  });

  it('skips a file it cannot fetch and still sends the rest', async () => {
    const { s, client, fetchBytes } = sender(null);
    fetchBytes.mockResolvedValueOnce(null);
    await s.send(client as never, integration, '5501', [{ kind: 'photo', key: file('a.png') }, { kind: 'video', key }]);
    expect(client.sendMedia).toHaveBeenCalledTimes(1);
    expect(client.sendMedia.mock.calls[0][1]).toBe('video');
  });
});
