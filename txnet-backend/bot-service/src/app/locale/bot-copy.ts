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

  text(lang: string, text: BotText, depth = 0): string {
    // A value that is a `BotText` is a word this bot owns — a status, a
    // channel — and is translated before it is interpolated. The depth limit
    // is there because `values` is built by a flow: a sentence that nests
    // itself would otherwise be a stack overflow on one chat message.
    const values = this.resolve(lang, text.values, depth);

    // Already localized by whoever produced it (an `auth-api` `msg`): passing
    // it through is not inlined copy, and re-keying it here would mean
    // translating the same sentence twice, in two services.
    if (text.raw !== undefined) return interpolate(text.raw, values);
    if (!text.key) return '';

    const [head, ...rest] = text.key.split('.');
    const namespace = head === 'bot' ? 'bot' : 'notifications';
    const flatKey = head === 'bot' ? rest.join('.') : text.key;

    const value = this.locale.getKey(lang, namespace, flatKey);
    const template =
      typeof value === 'string' && value.length > 0
        ? value
        : (BOT_COPY_FALLBACKS[text.key] ?? text.key);

    return interpolate(template, values);
  }

  /** Each value as a string: a nested `BotText` translated, everything else left alone. */
  private resolve(
    lang: string,
    values: BotText['values'],
    depth: number,
  ): Record<string, string | number> | undefined {
    if (!values) return undefined;
    const out: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(values)) {
      if (isText(value)) {
        out[name] = depth < NESTING_LIMIT ? this.text(lang, value, depth + 1) : '';
      } else {
        out[name] = value;
      }
    }
    return out;
  }
}

/** How deep a sentence may nest. Two is every case there is; the limit is a guard, not a feature. */
const NESTING_LIMIT = 3;

/** A value that is a sentence of its own, rather than something to print as it stands. */
function isText(value: string | number | BotText): value is BotText {
  return typeof value === 'object' && value !== null;
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
