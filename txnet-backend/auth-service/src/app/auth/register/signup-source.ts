import { BOT_PLATFORMS } from '@txnet-backend/messenger';
import { WEB_SIGNUP_SOURCE } from '@txnet-backend/shared-core';

import type { BotLinkStore } from '../bot-link/bot-link.store';

/**
 * Where a registration came through, for analytics' signups (F-1001-f): the
 * first bot platform holding a parked proof of this phone, else the web. Read
 * before `promoteProvenChat` clears the proof.
 */
export async function signupSourceOf(store: Pick<BotLinkStore, 'provenChat'>, phoneNumber: string): Promise<string> {
  for (const platform of BOT_PLATFORMS) {
    if ((await store.provenChat(platform, phoneNumber)) !== null) return platform;
  }
  return WEB_SIGNUP_SOURCE;
}
