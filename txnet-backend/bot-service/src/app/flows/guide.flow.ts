import { Injectable } from '@nestjs/common';
import { BotAction, BotText } from '@txnet-backend/messenger';
import { GUIDE_OSES, type GuideBlock, type GuideCalloutTone, type GuideOs } from '@txnet-backend/shared-core';
import { ChatContext, FlowResult } from '../conversation/nav.types';
import { BotGuide, GuideApiClient } from '../guide-api/guide-api.client';
import type { GuideMediaItem } from '../guide-api/guide-media.sender';
import { BotKey, BotKeys } from '../locale/bot-keys';
import { ACTIONS, say, view } from './views';

/** `go:android` — a system's guides. The OS is the payload, so a tap on an old screen still means it. */
export const GUIDE_OS_PREFIX = 'go:';
/** `gk:<key>` — one guide. A key is ≤ 60 characters, so this stays within a button's 64 bytes. */
export const GUIDE_KEY_PREFIX = 'gk:';

/**
 * A guide's text in one message, under the 4096 characters a platform takes,
 * with the title and the screen's own words around it. The rest is in the
 * panel, which shows a guide whole.
 */
export const GUIDE_TEXT_MAX = 3500;

const OS_KEYS: Record<GuideOs, BotKey> = BotKeys.guides.os;
const TONE_MARK: Record<GuideCalloutTone, string> = { info: 'ℹ️', tip: '💡', warning: '⚠️', danger: '⛔' };

/**
 * Guides in the chat (F-414-f, ADR-0115/0116): the main menu's help, and the
 * install guide by system then app — the panel's resolver for this bot's
 * tenant (`GuideApiClient`), so a reseller's own guide, its hide and the
 * platform's fallback are the panel's exactly. Every button carries what it
 * opens, so the flow keeps no state. A guide's text is shown flat and escaped
 * like every message; its pictures and video follow the screen (`media`).
 */
@Injectable()
export class GuideFlow {
  constructor(private readonly guides: GuideApiClient) {}

  /** The guides placed on the main menu, under the install guide. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const read = await this.guides.forSlot(ctx.integration.tenantId, 'bot_screen', 'main_menu', ctx.lang);
    const listed = read.ok ? read.guides : [];
    return {
      view: view('guides.menu', { key: BotKeys.guides.menu }, [
        [{ id: ACTIONS.guidesInstall, label: { key: BotKeys.action.guidesInstall } }],
        ...listed.map((g) => [guideButton(g)]),
      ]),
      nextState: null,
    };
  }

  /** Which system to install on. */
  install(): FlowResult {
    const buttons: BotAction[] = GUIDE_OSES.map((os) => ({ id: `${GUIDE_OS_PREFIX}${os}`, label: { key: OS_KEYS[os] } }));
    return { view: view('guides.os', { key: BotKeys.guides.pickOs }, [buttons.slice(0, 2), buttons.slice(2)]), nextState: null };
  }

  /** A system's guides (one per app), or one guide. */
  async tap(ctx: ChatContext, actionId: string): Promise<FlowResult> {
    const tenantId = ctx.integration.tenantId;
    if (actionId.startsWith(GUIDE_OS_PREFIX)) {
      const os = actionId.slice(GUIDE_OS_PREFIX.length);
      if (!(GUIDE_OSES as readonly string[]).includes(os)) return failed();
      const read = await this.guides.forSlot(tenantId, 'os', os, ctx.lang);
      if (!read.ok) return failed();
      if (read.guides.length === 0) return { view: say('guides.none', { key: BotKeys.guides.noneForOs }), nextState: null };
      return {
        view: view('guides.apps', { key: BotKeys.guides.pickApp, values: { os: { key: OS_KEYS[os as GuideOs] } } }, read.guides.map((g) => [guideButton(g)])),
        nextState: null,
      };
    }
    const read = await this.guides.one(tenantId, actionId.slice(GUIDE_KEY_PREFIX.length), ctx.lang);
    if (!read.ok) return failed();
    if (!read.guide) return { view: say('guides.gone', { key: BotKeys.guides.gone }), nextState: null };
    const g = read.guide;
    return {
      view: say('guides.screen', { key: BotKeys.guides.screen, values: { title: { raw: g.title }, text: { raw: guidePlainText(g.blocks) } } }),
      nextState: null,
      media: guideMedia(g.blocks),
    };
  }
}

const failed = (): FlowResult => ({ view: say('guides.failed', { key: BotKeys.guides.failed }), nextState: null });

// A guide's title is the tenant's data, not copy: shown as written.
const guideButton = (g: BotGuide): BotAction => ({ id: `${GUIDE_KEY_PREFIX}${g.key}`, label: { raw: g.title } as BotText });

/**
 * A guide's blocks as one plain text (F-414-f): Markdown's markers taken off,
 * a list as `•`/`1.` lines, a link as `label (url)` — only an http(s) one; any
 * other stays as written. The renderer escapes the result like every message,
 * so a reseller's text never becomes markup. Pictures and video are not here:
 * they follow as media.
 */
export function guidePlainText(blocks: readonly GuideBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(markdownToText(b.text));
    else if (b.type === 'steps') parts.push(b.items.map((it, i) => `${i + 1}. ${inline(it.text.replace(/\s*\n\s*/g, ' '))}`).join('\n'));
    else if (b.type === 'callout') parts.push(b.title ? `${TONE_MARK[b.tone]} ${b.title}\n${markdownToText(b.text)}` : `${TONE_MARK[b.tone]} ${markdownToText(b.text)}`);
  }
  const text = parts.filter(Boolean).join('\n\n');
  if (text.length <= GUIDE_TEXT_MAX) return text;
  const cut = text.slice(0, GUIDE_TEXT_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), GUIDE_TEXT_MAX - 200)).trimEnd()}…`;
}

/** The pictures and video a guide shows, in its order, each with what says what it is. */
export function guideMedia(blocks: readonly GuideBlock[]): GuideMediaItem[] {
  const out: GuideMediaItem[] = [];
  for (const b of blocks) {
    if (b.type === 'image') out.push({ kind: 'photo', key: b.file, caption: b.caption ?? b.alt });
    else if (b.type === 'video') out.push(b.caption ? { kind: 'video', key: b.file, caption: b.caption } : { kind: 'video', key: b.file });
    else if (b.type === 'steps') b.items.forEach((it, i) => it.image && out.push({ kind: 'photo', key: it.image, caption: String(i + 1) }));
  }
  return out;
}

function markdownToText(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const heading = /^#{1,3}\s+(.*)$/.exec(line);
      if (heading) return inline(heading[1]);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) return `• ${inline(bullet[1])}`;
      return inline(line);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inline(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1')
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, '$1');
}
