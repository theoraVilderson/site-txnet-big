import { BotText } from '@txnet-backend/messenger';
import { BotKey } from '../locale/bot-keys';

/** A screen's three sentences for a span: `{d, h}`, `{h, m}`, `{m}`. */
export interface SpanKeys {
  days: BotKey;
  hours: BotKey;
  minutes: BotKey;
}

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/** Time until an instant, as a span in two units — a span needs no time zone (F-707-p, F-0401-g). Past is zero minutes. */
export function spanUntil(atMs: number, nowMs: number, keys: SpanKeys): BotText {
  const minutes = Math.max(0, Math.floor((atMs - nowMs) / MINUTE_MS));
  const d = Math.floor(minutes / MINUTES_PER_DAY);
  const h = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const m = minutes % MINUTES_PER_HOUR;
  if (d > 0) return { key: keys.days, values: { d, h } };
  if (h > 0) return { key: keys.hours, values: { h, m } };
  return { key: keys.minutes, values: { m } };
}
