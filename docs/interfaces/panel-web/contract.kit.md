---
id: panel-web
layer: interface
status: active
version: 12
updated: 2026-09-11
---

# Contract — panel-web: the shared UI kit (F-093-b)

Split from [contract.md](contract.md) at 250 lines (§10). The pieces every
money page (F-093-c..g) builds on, so none of them re-derives a formatter, a
calendar or a pager. Components live in `(panel)/_components/kit/`, pure
helpers in `(panel)/_lib/`. No page uses them yet.

| piece | file | what a page passes |
|---|---|---|
| `Skeleton` | `_components/kit/Skeleton.tsx` | `shape` + size classes |
| `TableSkeleton` | `_components/kit/TableSkeleton.tsx` | `rows`, `columns`, `withPagination` |
| `Pagination` | `_components/kit/Pagination.tsx` | `page`, `totalPages`, `totalItems`, `pageSize`, `onPageChange` |
| `DatePicker` | `_components/kit/DatePicker.tsx` | `value` / `onChange` as ISO `YYYY-MM-DD` |
| `formatMoney`, `amountInWords` | `_lib/money.ts` | amount, currency code, `useLocale()` |
| `copyText` | `_lib/clipboard.ts` | text; resolves `false` when refused |

## Rules a page row has to know

1. **An amount arrives already in the currency it names.** The kit never
   converts: base -> display is the `currency` unit's job (ADR-0019). Legacy's
   `toToman` (÷10) has no counterpart here, on purpose.
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

## Proof

`_lib/money.test.ts` runs rules 1–4 against the shipped `en` and `fa`
`common.json`; a key the speller asks for that a language lacks fails it.
