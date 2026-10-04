import type { MockInstance } from 'vitest';
import { BOT_PLATFORMS } from './bot-platform';
import { capabilitiesOf } from './capabilities';
import {
  TelegramLikeBotClient,
  WEBHOOK_ALLOWED_UPDATES,
} from './telegram-like-bot.client';
import { incomingFileOf } from './update.types';

/**
 * The registration is half of whether the bot works at all, and the half that
 * fails silently: a webhook registered for `['message']` alone answers typed
 * text perfectly and drops every button tap, on a URL that looks correct in
 * `getWebhookInfo`. These tests exist because that shipped once.
 */
describe('TelegramLikeBotClient webhook registration', () => {
  const client = () =>
    new TelegramLikeBotClient('telegram', 'https://api.test', 'TOKEN', 1000);

  let fetchMock: MockInstance;

  const reply = (result: unknown) =>
    ({
      ok: true,
      json: async () => ({ ok: true, result }),
    }) as unknown as Response;

  beforeEach(() => {
    fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(reply({ url: '' }));
  });
  afterEach(() => fetchMock.mockRestore());

  const bodyOf = (call: unknown[]) =>
    JSON.parse((call[1] as RequestInit).body as string);

  it('registers callback_query — every screen is an inline keyboard', async () => {
    // The premise: if this ever stops holding, taps stop being how the bot is
    // driven and this test is the wrong one, not the capability.
    for (const p of BOT_PLATFORMS) {
      expect(capabilitiesOf(p).inlineKeyboard).toBe(true);
    }

    await client().setWebhook('https://api.test/api/bot/telegram/webhook/s', 's');

    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.allowed_updates).toContain('callback_query');
    expect(body.allowed_updates).toContain('message');
  });

  it('reads back the update types, not just the URL', async () => {
    fetchMock.mockResolvedValue(
      reply({ url: 'https://api.test/hook', allowed_updates: ['message'] }),
    );

    await expect(client().getWebhookInfo()).resolves.toEqual({
      url: 'https://api.test/hook',
      allowedUpdates: ['message'],
    });
  });

  it('treats a missing allowed_updates as the platform default', async () => {
    // Telegram omits the field when it was never narrowed, and the default set
    // already carries everything here — so this must not read as "narrow".
    fetchMock.mockResolvedValue(reply({ url: 'https://api.test/hook' }));

    const info = await client().getWebhookInfo();
    expect(info?.allowedUpdates).toEqual([]);
    expect(TelegramLikeBotClient.deliversEveryUpdate([])).toBe(true);
  });

  it('calls an explicit narrow registration incomplete', () => {
    expect(TelegramLikeBotClient.deliversEveryUpdate(['message'])).toBe(false);
    expect(
      TelegramLikeBotClient.deliversEveryUpdate([...WEBHOOK_ALLOWED_UPDATES]),
    ).toBe(true);
  });

  it('answers null when the platform could not be asked', async () => {
    // Not the same as "no webhook": the caller must not overwrite on it.
    fetchMock.mockRejectedValue(new Error('unreachable'));
    await expect(client().getWebhookInfo()).resolves.toBeNull();
  });
});

/**
 * A file a user sent (F-309). What would break silently: the photo's smallest
 * size taken instead of its largest, a caption lost, and a file over the cap
 * downloaded anyway.
 */
describe('a file sent into the chat', () => {
  it('reads the largest photo size, or the document, with its caption', () => {
    expect(incomingFileOf({ photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 90 }], caption: 'see' })).toEqual({
      kind: 'photo',
      fileId: 'big',
      sizeBytes: 90,
      caption: 'see',
    });
    expect(incomingFileOf({ document: { file_id: 'd', file_name: 'a.pdf', mime_type: 'application/pdf' } })).toEqual({
      kind: 'document',
      fileId: 'd',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
    });
    expect(incomingFileOf({ text: 'hi' })).toBeUndefined();
  });

  it('fetches it by getFile then the file path, and refuses one over the cap', async () => {
    const client = new TelegramLikeBotClient('bale', 'https://api.test', 'TOKEN', 1000);
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/getFile')
        ? ({ ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'photos/1.jpg', file_size: 3 } }) } as unknown as Response)
        : ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Response),
    );
    try {
      expect(await client.downloadFile('f-1', 10)).toEqual(Buffer.from([1, 2, 3]));
      expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.test/file/botTOKEN/photos/1.jpg');
      fetchMock.mockClear();
      expect(await client.downloadFile('f-1', 2)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
