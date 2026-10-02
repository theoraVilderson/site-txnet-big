---
id: panel-web
layer: interface
status: active
version: 15
updated: 2026-10-02
---

# Contract — panel-web: the shared UI kit (F-093-b)

Split from [contract.md](contract.md) at 250 lines (§10). The pieces every
money page (F-093-c..g) builds on, so none of them re-derives a formatter, a
calendar or a pager. Components live in `(panel)/_components/kit/`, pure
helpers in `(panel)/_lib/`. F-093-d is the first page to use them, and
[contract.financial.md](contract.financial.md) is the worked example of what a
page still owns on top of them.

| piece | file | what a page passes |
|---|---|---|
| `Skeleton` | `_components/kit/Skeleton.tsx` | `shape` + size classes |
| `TableSkeleton` | `_components/kit/TableSkeleton.tsx` | `rows`, `columns`, `withPagination` |
| `Pagination` | `_components/kit/Pagination.tsx` | `page`, `totalPages`, `totalItems`, `pageSize`, `onPageChange` |
| `DatePicker` | `_components/kit/DatePicker.tsx` | `value` / `onChange` as ISO `YYYY-MM-DD` |
| `Select` | `_components/kit/Select.tsx` | `value`, `onChange`, `options` `{value,label}[]`, `placeholder?`, `ariaLabel?`, `invalid?` — use it instead of a native `<select>`, whose option list the browser draws unstyled; the list is portaled, so it is not clipped inside a modal |
| `formatMoney`, `amountInWords` | `_lib/money.ts` | amount, currency code, `useLocale()` |
| `copyText` | `_lib/clipboard.ts` | text; resolves `false` when refused |
| `formatInstant` | `_lib/datetime.ts` | an ISO instant, `useLocale().lang` |
| `numberLocale`, `LATIN_DIGITS` | `_lib/digits.ts` | `useLocale().lang` — the locale every `Intl` formatter takes |

## Rules a page row has to know

1. **An amount arrives already in the currency it names.** The kit never
   converts: base -> display is the `currency` unit's job (ADR-0019). Legacy's
   `toToman` (÷10) has no counterpart here, on purpose.
1a. **The code is the answer's, never a default (F-116-h3, ADR-0098 part 3).**
   `money.ts` has no `BASE_CURRENCY`. A screen passes the `currencyCode` its
   route answered beside the amount — a list row its **own**, so a USD row
   written before a switch to IRR still reads as dollars; a balance its
   wallet's. With no code there is no figure in a currency: a live event
   without one is not shown, a new rule's or gateway's form names the tenant's
   (the presets answer's) or none. Spec: `financial/_components/LedgerRow.test.tsx`.
2. **An amount stays a decimal string.** Pass the API's `Decimal` string as is.
   Rounding is half away from zero to the currency's decimals, done on the
   string; `Intl.NumberFormat` receives the exact string, never a float.
   `options.decimals` (the currency row's `decimalPlaces`) wins over Intl.
3. **A non-ISO display currency is a locale template.** `IRT` renders through
   `common.money.currency.IRT.format`; a new one is a `NON_ISO` entry plus that
   key in every language.
4. **Words are locale content, not code.** Every number word, joiner and
   currency name is a `common.money.*` key; a new language is a JSON file, not
   a branch. `amountInWords` answers `null` for a currency with no names, bad
   input, or past `trillion` — the caller hides the line.
5. **The date value is calendar-neutral.** `DatePicker` shows a Jalali grid in
   `fa` and a Gregorian one otherwise, but its value is always a Gregorian ISO
   date with ASCII digits. Whether a "to" date covers its whole day, and in
   which timezone, is the caller's decision, not the picker's.
6. **`Pagination` owns no navigation.** It calls `onPageChange`; the page pushes
   `?page=` and shows its skeleton. It renders nothing for one page.
7. **A timestamp is an instant, and the calendar is the language's.**
   `formatInstant` reads the calendar from the language tag — `fa` is Jalali to
   ICU already — so there is no calendar table here either and a new language
   needs no entry in one. The zone is the viewer's: someone checking when a
   payment expired wants the clock on their own wall. An absent or unreadable
   instant answers `null` rather than a placeholder, so the caller hides the
   line instead of printing a date nothing vouches for. "The viewer's" is
   their **resolved** zone (below). Added by F-093-d;
   `contract.financial.md` rule 2 is the other half, where a *picked day* goes
   back the other way and becomes a range of instants.
8. **Digits are Latin in every language** (user decision, 2026-09-13). Every
   `Intl` formatter takes `numberLocale(lang)` (`<lang>-u-nu-latn`), never the
   bare `lang`, and `DatePicker` passes `LATIN_DIGITS`. Only the glyphs are
   fixed: `fa` still reads Jalali and its own currency words. A literal Persian
   digit in `locales/` is the same violation. Proof: `_lib/digits.test.ts`.

## The zone a date is drawn in (TZ-1-e, ADR-0108)

Every instant is UTC on the wire; the wall clock is the caller's resolved
zone — their pick, else this browser's report, else their tenant's, else the
platform's — as `GET /auth/me/timezone` answers it
([auth-api/contract.time-zone.md](../auth-api/contract.time-zone.md)). The
panel never re-derives it. Code: `src/lib/time-zone.ts`.

| # | Rule | Why |
|---|---|---|
| Z1 | After sign-in (and after an account switch) `PanelSessionContext` reads the zone and, unless the user picked one, reports this browser's `Intl` zone as `browser` — only when the row does not already hold it. A failed read leaves the browser's clock; it never leaves the panel | the only automatic source (ADR-0108 point 4); a page load costs a read, not a write |
| Z2 | `formatInstant` draws in `displayZone()`: the resolved zone, remembered in `localStorage` so the next load draws in it from its first frame. An unreadable zone falls back to the browser's clock | one setter, so 40-odd call sites follow without passing a zone |
| Z3 | `/settings` "Time zone": a pick saves `user`; "Automatic — this device" clears the pick, then reports the browser's zone. "Now in use" is the answer's `resolved`, never the field | a report is never stored over a pick, so automatic is two calls |
| Z4 | A tenant's zone (`TenantTimeZoneCard`, `tenant/contract.time-zone.md`): a reseller's on its workspace console, the platform's on `/settings` for `platform_owner` + `tenant.manage` — the currency card's rule | the same admission as the operating currency |
| Z5 | Every zone field is `ZoneSelect`: the browser's `Intl.supportedValuesOf`, a saved zone it lacks kept first; with `nullLabel`, a first option meaning null (quiet hours: "same as my time zone", TZ-1-f) | opening a picker never changes what is stored |
| Z6 | A day that is a business rule — a price's start day, a coupon's day bounds — stays on `PLATFORM_DEFAULT_TIMEZONE`, the clock billing's gates read; it is not the viewer's | the server judges those days in Tehran, so the form must too |

Proof: `src/lib/time-zone.test.ts`.

## Proof

`_lib/money.test.ts` runs rules 1–4 against the shipped `en` and `fa`
`common.json`; a key the speller asks for that a language lacks fails it.
