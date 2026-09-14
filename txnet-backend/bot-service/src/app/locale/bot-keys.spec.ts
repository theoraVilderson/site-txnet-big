import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { BotKeys } from './bot-keys';

function leaves(tree: object, out: string[] = []): string[] {
  for (const value of Object.values(tree)) {
    if (typeof value === 'string') out.push(value);
    else leaves(value as object, out);
  }
  return out;
}

describe('BotKeys (C-07)', () => {
  it('is the generated `bot` namespace with the `bot.` prefix BotCopy routes on', () => {
    expect(BotKeys.action.cancel).toBe('bot.action.cancel');
    expect(leaves(BotKeys)).toEqual(leaves(BackendI18nKeys.bot).map((k) => `bot.${k}`));
  });
});
