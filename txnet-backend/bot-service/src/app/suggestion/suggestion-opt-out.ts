import { Injectable } from '@nestjs/common';
import { SUGGESTION_OPT_OUT_PREFIX } from '@txnet-backend/shared-core';

import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, FlowResult } from '../conversation/nav.types';
import { say } from '../flows/views';
import { BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import { AiApiClient } from './ai-api.client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Don't show this again" under an AI suggestion (F-038-g4, F-1505). The
 * button carries only the action id; **who** opts out is this chat's own
 * signed-in session — `GET /auth/me` with its token — and that session must
 * be of this bot's tenant. ai-service then finds the action only as that
 * user's (else 404), so a forwarded or stale button opts out nobody.
 *
 * Routed by prefix, like a language pick, so a tap lands whatever screen the
 * chat is on; it never changes that screen's state.
 */
@Injectable()
export class SuggestionOptOut {
  constructor(
    private readonly access: ChatAccess,
    private readonly api: AuthApiClient,
    private readonly ai: AiApiClient,
  ) {}

  async tap(ctx: ChatContext, actionId: string): Promise<FlowResult> {
    const id = actionId.slice(SUGGESTION_OPT_OUT_PREFIX.length);
    if (!UUID.test(id)) return this.gone();
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return { view: say('suggestion.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };

    const tenantId = ctx.integration.tenantId;
    const me = await this.api.me({ chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform, tenantId, accessToken });
    if (!me.ok || !me.data || me.data.tenant?.id !== tenantId) return this.gone();

    const done = await this.ai.optOut(id, { tenantId, subjectKind: 'user', subjectId: me.data.userId });
    if (!done.ok) return this.gone();
    return { view: say('suggestion.optedOut', { key: BotKeys.suggestion.optedOut }), nextState: null };
  }

  private gone(): FlowResult {
    return { view: say('suggestion.gone', { key: BotKeys.suggestion.gone }), nextState: null };
  }
}
