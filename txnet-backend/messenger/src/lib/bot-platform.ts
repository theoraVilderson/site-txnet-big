/** The messenger platforms that speak the Telegram Bot API shape. */
export type BotPlatform = 'telegram' | 'bale';

export const BOT_PLATFORMS: readonly BotPlatform[] = ['telegram', 'bale'];

export function isBotPlatform(value: string): value is BotPlatform {
  return BOT_PLATFORMS.includes(value as BotPlatform);
}
