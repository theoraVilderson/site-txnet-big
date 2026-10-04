import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { supportOpenCallback } from '@txnet-backend/shared-core';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { SupportApiClient, SupportConversation, SupportThread } from '../support-api/support-api.client';
import { ChatFiles } from './chat-files';
import { SUPPORT_REFUSAL_KEYS, SupportFlow, supportAction } from './support.flow';
import { ACTIONS } from './views';

/**
 * Support from the chat (F-309): the panel's own `/api/support/*` routes, so
 * the chat and the panel hold one conversation. support decides everything.
 * What would break silently here:
 *  - **a button that cannot be sent** — a callback is at most 64 bytes, and a
 *    file's button names two ids;
 *  - **a reply that lands in another thread** — the thread typed into is the
 *    one in the state, and a notice's tap opens the one it names;
 *  - **a file the chat sent that never reaches support**, or one support
 *    refused told as a raw key;
 *  - **rate / reopen offered where support refuses them**.
 */
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const CID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const AID = 'a1a2a3a4-b1b2-4c1c-8d1d-e1e2e3e4e5e6';
const CAT = 'c0c1c2c3-d0d1-4e0e-8f0f-a0a1a2a3a4a5';

const conversation = (over: Partial<SupportConversation> = {}): SupportConversation => ({
  id: CID,
  subject: 'VPN does not connect',
  status: 'pending_user',
  lastSeq: 3,
  unread: 1,
  rating: null,
  ...over,
});

const thread = (over: Partial<SupportConversation> = {}): SupportThread => ({
  conversation: conversation(over),
  hasEarlier: false,
  messages: [
    { id: 'm1', seq: 1, senderKind: 'user', mine: true, body: 'It does not connect', attachments: [] },
    {
      id: 'm2',
      seq: 2,
      senderKind: 'agent',
      mine: false,
      body: 'Try this config',
      attachments: [
        { id: AID, fileName: 'config.pdf', contentType: 'application/pdf', sizeBytes: 900, scanStatus: 'clean', expired: false },
        { id: 'b0000000-0000-4000-8000-000000000000', fileName: 'old.png', contentType: 'image/png', sizeBytes: 1, scanStatus: 'clean', expired: true },
        { id: 'c0000000-0000-4000-8000-000000000000', fileName: 'wait.png', contentType: 'image/png', sizeBytes: 1, scanStatus: 'pending', expired: false },
      ],
    },
  ],
});

function harness(o: { list?: unknown; thread?: unknown; categories?: unknown; upload?: unknown; send?: unknown; download?: unknown } = {}) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as Mocked<AuthApiClient>;
  const api = {
    conversations: vi.fn().mockResolvedValue(o.list ?? ok({ items: [conversation()] })),
    categories: vi.fn().mockResolvedValue(o.categories ?? ok([])),
    open: vi.fn().mockResolvedValue(ok(conversation({ status: 'open', lastSeq: 1 }))),
    thread: vi.fn().mockResolvedValue(o.thread ?? ok(thread())),
    send: vi.fn().mockResolvedValue(o.send ?? ok({})),
    read: vi.fn().mockResolvedValue(ok({ lastReadSeq: 3 })),
    rate: vi.fn().mockResolvedValue(ok({ score: 5 })),
    reopen: vi.fn().mockResolvedValue(ok({ id: CID, status: 'pending_agent' })),
    upload: vi.fn().mockResolvedValue(o.upload ?? ok({})),
    attachment: vi.fn().mockResolvedValue(ok({ fileName: 'config.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF') })),
  } as unknown as Mocked<SupportApiClient>;
  const files = {
    download: vi.fn().mockResolvedValue('download' in o ? o.download : { fileName: 'photo.jpg', contentType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8]) }),
  } as unknown as Mocked<ChatFiles>;
  const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
  return { api, files, flow: new SupportFlow(api, new ChatAccess(auth, sessions), files) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);
const inThread: NavState = { flow: 'support', step: 'support.thread', data: { conversationId: CID } };

describe('the reasons support gives', () => {
  it('has a sentence for every refusal it names, each a reason support can actually answer', () => {
    const file = readFileSync(join(__dirname, '../../../../support-service/src/app/conversations/refusal.ts'), 'utf8');
    const m = /export type ConversationRejection =([^;]*);/.exec(file);
    if (!m) throw new Error('ConversationRejection is no longer a literal union — this test is stale');
    const union = new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    for (const reason of Object.keys(SUPPORT_REFUSAL_KEYS)) expect(union.has(reason)).toBe(true);
    for (const reason of ['closed', 'file_rejected', 'file_too_large', 'file_infected', 'quota_exceeded', 'reopen_expired', 'too_many_unfinished']) {
      expect(SUPPORT_REFUSAL_KEYS[reason]).toBeDefined();
    }
  });
});

describe('every button fits in a callback', () => {
  it('stays under 64 bytes, a file button included', async () => {
    const { flow } = harness();
    const shown = await flow.tap(ctx, supportAction.open(CID));
    for (const id of ids(shown)) expect(Buffer.byteLength(id)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(supportOpenCallback(CID))).toBeLessThanOrEqual(64);
  });

  it('is the open button a notice carries (shared-core), so a tap under a notice opens that thread', () => {
    expect(supportAction.open(CID)).toBe(supportOpenCallback(CID));
  });
});

describe('the list', () => {
  it('names each thread and offers a new one', async () => {
    const { flow } = harness();
    const r = await flow.start(ctx);
    expect(ids(r)).toEqual([supportAction.open(CID), ACTIONS.supportNew]);
    expect(r.nextState).toBeNull();
  });

  it('with no threads, still offers a new one', async () => {
    const { flow } = harness({ list: ok({ items: [] }) });
    const r = await flow.start(ctx);
    expect(r.view.body.key).toBe(BotKeys.support.none);
    expect(ids(r)).toEqual([ACTIONS.supportNew]);
  });
});

describe('a thread', () => {
  it('shows the messages, marks them read, and waits for a reply in that thread', async () => {
    const { flow, api } = harness();
    const r = await flow.tap(ctx, supportAction.open(CID));
    expect(api.thread).toHaveBeenCalledWith(CID, expect.anything());
    expect(api.read).toHaveBeenCalledWith(CID, 3, expect.anything());
    expect(r.nextState).toMatchObject({ flow: 'support', step: 'support.thread', data: { conversationId: CID } });
    expect(JSON.stringify(r.view.body)).toContain('Try this config');
  });

  it('offers a button for a file only once it can be fetched — clean and not expired', async () => {
    const { flow } = harness();
    const r = await flow.tap(ctx, supportAction.open(CID));
    const fileButtons = ids(r).filter((id) => id.startsWith('sup:f:'));
    expect(fileButtons).toEqual([supportAction.file(CID, AID)]);
  });

  it('a file button sends the file into the chat', async () => {
    const { flow, api } = harness();
    const r = await flow.tap(ctx, supportAction.file(CID, AID));
    expect(api.attachment).toHaveBeenCalledWith(CID, AID, expect.anything());
    expect(r.document?.fileName).toBe('config.pdf');
  });

  it('rating and reopen are offered only where support takes them', async () => {
    const open = await harness().flow.tap(ctx, supportAction.open(CID));
    expect(ids(open).some((id) => id.startsWith('sup:r:') || id.startsWith('sup:x:'))).toBe(false);

    const resolved = await harness({ thread: ok(thread({ status: 'resolved' })) }).flow.tap(ctx, supportAction.open(CID));
    expect(ids(resolved)).toContain(supportAction.rate(CID, 5));
    expect(ids(resolved)).not.toContain(supportAction.reopen(CID));

    const closedRated = await harness({ thread: ok(thread({ status: 'closed', rating: { score: 4 } })) }).flow.tap(ctx, supportAction.open(CID));
    expect(ids(closedRated)).toContain(supportAction.reopen(CID));
    expect(ids(closedRated).some((id) => id.startsWith('sup:r:'))).toBe(false);
  });

  it('a rating and a reopen go to support, then show the thread again', async () => {
    const { flow, api } = harness();
    await flow.tap(ctx, supportAction.rate(CID, 5));
    expect(api.rate).toHaveBeenCalledWith(CID, 5, expect.anything());
    await flow.tap(ctx, supportAction.reopen(CID));
    expect(api.reopen).toHaveBeenCalledWith(CID, expect.anything());
  });
});

describe('replying', () => {
  it('typed text goes to the thread in the state', async () => {
    const { flow, api } = harness();
    const r = await flow.handle({ ...ctx, text: 'still broken' }, inThread, null);
    expect(api.send).toHaveBeenCalledWith(CID, 'still broken', expect.anything());
    expect(r.nextState?.data.conversationId).toBe(CID);
  });

  it('a file the chat sent is fetched from the messenger and uploaded, its caption as the text', async () => {
    const { flow, api, files } = harness();
    const file = { kind: 'photo' as const, fileId: 'tg-file-1', caption: 'screenshot' };
    await flow.handle({ ...ctx, file }, inThread, null);
    expect(files.download).toHaveBeenCalledWith(expect.objectContaining({ chatId: '5501' }), file);
    expect(api.upload).toHaveBeenCalledWith(CID, [expect.objectContaining({ fileName: 'photo.jpg', contentType: 'image/jpeg' })], 'screenshot', expect.anything());
  });

  it("support's refusal is told in the bot's own sentence, and the thread stays open to try again", async () => {
    const { flow } = harness({ upload: { ok: false, msg: 'translated', error: { reason: 'file_rejected' } } });
    const r = await flow.handle({ ...ctx, file: { kind: 'document', fileId: 'x', fileName: 'a.exe' } }, inThread, null);
    expect(r.view.hint?.key).toBe(SUPPORT_REFUSAL_KEYS.file_rejected);
    expect(r.nextState?.data.conversationId).toBe(CID);
  });

  it('a file the messenger would not hand over is said so, never sent as nothing', async () => {
    const { flow, api } = harness({ download: null });
    const r = await flow.handle({ ...ctx, file: { kind: 'document', fileId: 'x' } }, inThread, null);
    expect(api.upload).not.toHaveBeenCalled();
    expect(r.view.hint?.key).toBe(BotKeys.support.fileUnreadable);
  });
});

describe('a new thread', () => {
  it('asks the category when the tenant has them, then the text, then opens it', async () => {
    const { flow, api } = harness({ categories: ok([{ id: CAT, key: 'billing', name: 'Billing' }]) });
    const asked = await flow.tap(ctx, ACTIONS.supportNew);
    expect(ids(asked)).toContain(supportAction.category(CAT));

    const compose = await flow.tap(ctx, supportAction.category(CAT));
    expect(compose.nextState).toMatchObject({ flow: 'support', step: 'support.compose', data: { categoryId: CAT } });

    const opened = await flow.handle({ ...ctx, text: 'My VPN is slow' }, compose.nextState as NavState, null);
    expect(api.open).toHaveBeenCalledWith({ body: 'My VPN is slow', categoryId: CAT }, expect.anything());
    expect(opened.nextState).toMatchObject({ step: 'support.thread', data: { conversationId: CID } });
  });

  it('with no categories goes straight to the text', async () => {
    const r = await harness().flow.tap(ctx, ACTIONS.supportNew);
    expect(r.nextState).toMatchObject({ step: 'support.compose', data: {} });
  });
});
