import { Injectable } from '@nestjs/common';
import { BotText, BotTranslator } from '@txnet-backend/messenger';
import { LocaleService } from './locale.service';
import { BOT_COPY_FALLBACKS } from './bot-copy.fallbacks';

/**
 * Turns a `BotText` (an i18n key plus values) into a string in the chat's
 * language. The renderer is handed one of these, so `messenger` needs no
 * locale client and no flow ever holds a sentence.
 *
 * Namespaces are derived from the key's first segment, which is why bot copy
 * is `bot.*` (`locales/backend/langs/<lang>/bot.json`) and the link flow's
 * existing strings stay `otp.botLink.*` in `notifications` — the same keys
 * `auth-service` already serves, translated once.
 */
@Injectable()
export class BotCopy {
  constructor(private readonly locale: LocaleService) {}

  translator(lang: string): BotTranslator {
    return (text: BotText) => this.text(lang, text);
  }

  text(lang: string, text: BotText): string {
    // Already localized by whoever produced it (an `auth-api` `msg`): passing
    // it through is not inlined copy, and re-keying it here would mean
    // translating the same sentence twice, in two services.
    if (text.raw !== undefined) return interpolate(text.raw, text.values);
    if (!text.key) return '';

    const [head, ...rest] = text.key.split('.');
    const namespace = head === 'bot' ? 'bot' : 'notifications';
    const flatKey = head === 'bot' ? rest.join('.') : text.key;

    const value = this.locale.getKey(lang, namespace, flatKey);
    const template =
      typeof value === 'string' && value.length > 0
        ? value
        : (BOT_COPY_FALLBACKS[text.key] ?? text.key);

    return interpolate(template, text.values);
  }
}

/** `{{name}}` -> the value, leaving an unknown placeholder visible on purpose. */
function interpolate(
  template: string,
  values?: Record<string, string | number>,
): string {
  if (!values) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    name in values ? String(values[name]) : whole,
  );
}
