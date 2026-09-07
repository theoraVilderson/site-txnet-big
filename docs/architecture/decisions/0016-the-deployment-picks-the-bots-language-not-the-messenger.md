---
id: adr-0016
status: accepted
updated: 2026-09-07
---

# ADR 0016 — the deployment picks the bot's language, not the messenger

- **Status:** accepted
- **Date:** 2026-09-07
- **Affects units:** bot-app, auth-api, i18n

## Context

A Telegram or Bale update carries `from.language_code` — the language that
person's *messenger app* is set to. It was the first thing the bot consulted for
a chat that had never chosen, so an English-language Telegram client got an
English welcome from a Persian reseller's bot.

`.env` had said `DEFAULT_LANGUAGE=fa` since the beginning. It had no effect on
the bot's greeting, for two reasons that both looked like the other one's job:

- `ChatLanguage` consulted only `BOT_DEFAULT_LANGUAGE`, which is declared in the
  zod schema and was **set nowhere** — not in `.env`, not in `.env.example`, and
  not in the bot-service block of `dev-docker/docker-compose.main.yml`. Compose
  uses explicit `environment:` lists with no `env_file:`, so a var nobody lists
  does not exist inside the container at all.
- `BotLinkService.fallbackLang()` in auth-service hardcoded
  `startsWith('fa') ? 'fa' : 'en'`, ignoring both the configuration and the set
  of languages locale-service actually serves.

So the platform had a configured language, and neither of the two places that
answer a stranger read it.

## Decision

**The messenger's hint is the last resort, not the first.** A chat that has
never chosen is answered in this order:

| # | source | where |
|---|---|---|
| 1 | the chat's own `/lang` choice | Redis, `RedisKeys.botLang`, idle TTL |
| 2 | `BOT_DEFAULT_LANGUAGE` | optional; the bot differs from the platform |
| 3 | `DEFAULT_LANGUAGE` | always set — in practice this is the answer |
| 4 | `from.language_code` | only if neither 2 nor 3 is served |

A configured language locale-service does not serve is a misconfiguration, so it
is skipped with a warning and the next step answers. It is never a dead end.

`BOT_DEFAULT_LANGUAGE` therefore stops meaning "unset = follow the phone". It
means "the bot speaks something other than the rest of this deployment", and
almost every deployment leaves it unset.

`auth-api` applies the same order in `BotLinkService.fallbackLang()`, minus step
1: the `/lang` choice lives in bot-service's Redis and auth-service cannot see
it. That function only runs for a chat with no pending link record — when there
*is* one, `link.lang` (what the panel was speaking when the deep link was made)
already wins, and that is a stronger signal than either.

## Why not follow the messenger

Because the guess is about a phone and the question is about a product. This
platform is white-label and per-tenant: a reseller sells in a language, and that
language is a property of the storefront, not of whoever walks into it. Someone
in Iran running an English-language Telegram is a normal customer, not an
English speaker — and before this decision they had no way to be understood and
no way to ask.

The cost is real and small: a genuinely English-speaking customer sees one
Persian screen and taps `/lang`. The reverse cost — the tenant's own customers
greeted in a language the tenant does not sell in — is paid on the first
message, by everyone, and looks like a broken product rather than a setting.

## Consequences

- **`.env`'s existing `DEFAULT_LANGUAGE=fa` starts taking effect.** No new
  variable is required for the fix; this is a behaviour change on the next
  deploy of an unchanged `.env`.
- **`BOT_DEFAULT_LANGUAGE`, `BOT_LANG_TTL_SEC` and `BOT_COMMAND_LANGS` now
  reach the container**, as optional `${VAR:-}` entries. The bot-service env
  schema maps an empty string to unset (`optional()`), so an unset override
  behaves as absent rather than as `''`.
- **`BOT_COMMAND_LANGS` was read at `bot-webhook.registrar.ts` and declared
  nowhere.** Declared in the same pass — same class of defect, same fix.
- **`/lang` is now the only way to depart from the tenant's language**, which
  raises the cost of that command being hard to find. Worth watching when the
  bot copy is rewritten.
- A deployment that genuinely wants the old behaviour has no switch for it. That
  is deliberate: it was never a feature, it was an unset variable.

## Alternatives considered

- **Set `BOT_DEFAULT_LANGUAGE=fa` in `.env` and change no code.** One line, and
  it fixes the symptom for this deployment. It leaves the precedence wrong for
  every future one, and leaves `fallbackLang()`'s hardcoded `'en'` untouched.
- **Keep the messenger hint above the configured default, but only when
  locale-service serves it.** Reads reasonable and is what `resolveLanguage()`
  already does for HTTP `Accept-Language`. Rejected because a browser's
  `Accept-Language` is a preference the user set for the web; a messenger's
  `language_code` is the language they read their friends' messages in, and the
  two are not the same claim.
- **Ask on first contact.** Honest, and it costs every user a tap before they
  have any reason to care. `/lang` gives the same escape hatch to the few who
  need it, and nothing to the many who do not.
