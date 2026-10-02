import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import { ACTIONS, TIME_ZONE_ACTION_PREFIX, TIME_ZONE_CHOICES, say, timeZoneView } from './views';

const PICK: NavState = { flow: 'timeZone', step: 'timeZone.pick', data: {} };

/**
 * Bot settings: which clock this user is on (TZ-1-h, ADR-0108 point 7).
 *
 * The bot holds no zone and decides nothing about one. It reads and writes
 * `/auth/me/timezone` — the route the panel uses — so the chat and the panel
 * cannot disagree, and a zone is never inferred from the messenger (Telegram
 * and Bale send none; identity `contract.time-zone.md` rule 5).
 *
 * A pick is always `source: 'user'`. "Same as the panel" clears that pick, and
 * **only** that pick: auth-api's clear erases whatever is stored, so sent over
 * the panel's own browser report it would push the user down to the tenant's
 * zone — the opposite of what the button says.
 */
@Injectable()
export class TimeZoneFlow {
  constructor(
    private readonly api: AuthApiClient,
    private readonly access: ChatAccess,
  ) {}

  /** The screen: the zone in force, why, and the short list. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const mine = await this.api.myTimeZone(this.ctxFor(ctx, accessToken));
    if (!mine.ok || !mine.data) return { view: say('timeZone.failed', { raw: mine.msg }), nextState: null };

    const { resolved, timezone, source } = mine.data;
    // The zone in force is always on the list, so opening the screen and
    // tapping what is ticked can never move the user somewhere else.
    const zones = (TIME_ZONE_CHOICES as readonly string[]).includes(resolved.zone)
      ? TIME_ZONE_CHOICES
      : [resolved.zone, ...TIME_ZONE_CHOICES];
    return {
      view: timeZoneView(zones, { ...resolved, chosen: source === 'user' ? timezone : null }, new Date()),
      nextState: PICK,
    };
  }

  async handle(ctx: ChatContext, state: NavState, actionId: string | null): Promise<FlowResult> {
    if (actionId === ACTIONS.timeZoneFollowPanel) return this.followPanel(ctx, state);
    if (actionId?.startsWith(TIME_ZONE_ACTION_PREFIX)) {
      return this.choose(ctx, state, actionId.slice(TIME_ZONE_ACTION_PREFIX.length));
    }
    return { view: say('timeZone.pick', { key: BotKeys.common.pickOne }), nextState: state };
  }

  private async choose(ctx: ChatContext, state: NavState, zone: string): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    // Validated by auth-api, not here: a stale button's zone is refused there
    // in auth-api's own words, like every other rule this bot appears to have.
    const saved = await this.api.setMyTimeZone({ zone, source: 'user' }, this.ctxFor(ctx, accessToken));
    if (!saved.ok || !saved.data) return { view: say('timeZone.refused', { raw: saved.msg }), nextState: state };
    return {
      view: say('timeZone.chosen', { key: BotKeys.timeZone.chosen, values: { zone: saved.data.resolved.zone } }),
      nextState: null,
    };
  }

  private async followPanel(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();
    const call = this.ctxFor(ctx, accessToken);

    const mine = await this.api.myTimeZone(call);
    if (!mine.ok || !mine.data) return { view: say('timeZone.failed', { raw: mine.msg }), nextState: state };

    let resolved = mine.data.resolved;
    if (mine.data.source === 'user') {
      const cleared = await this.api.setMyTimeZone({ zone: null, source: 'user' }, call);
      if (!cleared.ok || !cleared.data) return { view: say('timeZone.refused', { raw: cleared.msg }), nextState: state };
      resolved = cleared.data.resolved;
    }
    return {
      view: say('timeZone.followsPanel', { key: BotKeys.timeZone.followsPanel, values: { zone: resolved.zone } }),
      nextState: null,
    };
  }

  /** `tenantId` is the bot's reseller (F-320), the same one every other call from this chat names. */
  private ctxFor(ctx: ChatContext, accessToken: string) {
    return {
      chatId: ctx.chatId,
      lang: ctx.lang,
      platform: ctx.platform,
      tenantId: ctx.integration.tenantId,
      accessToken,
    };
  }

  private signedOut(): FlowResult {
    return { view: say('timeZone.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}
