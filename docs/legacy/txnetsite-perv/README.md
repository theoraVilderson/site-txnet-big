# Legacy reference — txnetsite-perv

The previous Next.js + MongoDB app, kept **only** as a source to port from for
the legacy port series (`F-092-*`, `F-093-*` in `docs/BACKLOG.md`). Extracted
once on 2026-09-11 from `txnetsite-perv.zip`; only the parts a row ports are
here. Auth, captcha, SMS, sessions, rate limiting and RBAC were left out — this
repo already has them.

## Rules

- **Never read this folder whole, never `grep -r` it, never re-extract the zip.**
  Open only the files your backlog row names — the table below, or the row's
  `note`.
- Reference, not code: nothing here is imported, built, linted or tested.
  `tools/drift.py` and `tools/conventions.py` skip `docs/`, so it never shows as
  unowned code.
- Never port a file as is. Mongo → Prisma, integer rial → USD `Decimal`
  (ADR-0019), Persian literal → i18n key (C-01, C-06), plaintext merchant id →
  Vault. Each row's `note` names the legacy bug that must not come across.
- Delete this folder when the last `F-092` / `F-093` row is `done`.

## Row → files

All paths are under `src/`. `P` = `app/panel/(panel)`, `F` = `P/financial`.

| row | open only these |
|---|---|
| F-092-a | — (not in legacy) |
| F-092-b | `app/payment/verify/route.ts` (fulfillWalletChargeTransaction), `P/gift/route.ts` |
| F-092-c | — (legacy has no FX) |
| F-092-d | `models/Transactions.ts`, `models/PaymentSettings.tsx`, `models/Coupons.ts`, `models/CouponLocks.ts`, `types/transaction.ts`, `types/paymentSetting.ts`, `types/coupons.ts` |
| F-092-e | `lib/payment/fee/feeAndTaxCalculator.ts`, `F/deposit/payment/request/route.ts`, `F/deposit/payment/fee/calc/route.ts`, `configs/paymentSettings.ts` |
| F-092-f | `types/payment.ts`, `lib/payment/gateway/paymentFactory.ts`, `lib/payment/gateway/providers/zarinpal.ts`, `lib/request.ts` (requestHandler), `shared.ts` |
| F-092-g | `lib/payment/coupon/couponService.ts` (validateCoupons), `lib/couponHelpers.ts`, `configs/coupons.ts`, `configs/services.ts` |
| F-092-h | `lib/payment/coupon/couponService.ts` (reserve / commit / release), `models/CouponLocks.ts` |
| F-092-o | `F/deposit/payment/coupon/validate/route.ts`, `F/deposit/payment/fee/calc/route.ts`, `types/paymentSetting.ts` |
| F-092-i | `F/deposit/payment/request/route.ts`, `lib/validations.ts` (chargeRequestSchema) |
| F-092-j | `app/payment/verify/route.ts` |
| F-092-k | `models/Transactions.ts`, `models/CouponLocks.ts` (the TTL indexes it replaces) |
| F-092-l | `lib/payment/gateway/providers/zarinpal.ts` (isVerified) |
| F-092-m | `P/gift/route.ts`, `lib/validations.ts` (giftCheckSchema) |
| F-092-n | `F/_actions/balanceCalc.ts`, `F/_actions/getTransactions.ts`, `configs/transactions.ts`, `util/helper.ts` (parsePersianDate) |
| F-093-a | `P/_components/Dashboard.tsx`, `Sidebar.tsx`, `Nav.tsx`, `HiddenOnPhone.tsx`, `P/_stores/useDashboardUiStore.ts`, `P/layout.tsx`, `P/global.css`, `app/globals.css` (tokens only) |
| F-093-b | `components/Skeleton.tsx`, `F/_components/TableSkeleton.tsx`, `Pagination.tsx`, `PersianDatePicker.tsx`, `PersianDatePicker.css`, `F/_util/format.ts`, `util/helper.ts` (toEnglishDigits, parsePersianDate), `util/front.ts` |
| F-093-c | `P/_components/Vault.tsx`, `P/_stores/useAuthStore.ts` |
| F-093-d | `F/page.tsx`, `F/_components/FinancialTable.tsx`, `TransactionRow.tsx`, `TransactionRow/*`, `AdvancedFilter.tsx`, `TableWrapper.tsx`, `Loading.tsx`, `F/_context/LoadingContext.tsx` |
| F-093-e | `F/deposit/page.tsx`, `F/deposit/_components/*`, `F/deposit/_util/constants.ts`, `F/deposit/_types/type.ts`, `F/deposit/_actions/deposit.ts` |
| F-093-f | `app/payment/payment/success/**`, `app/payment/payment/failed/**` |
| F-093-g | `P/_components/DiscountModal.tsx` |
| F-093-h | `P/_components/Notifications.tsx` |

Not listed on any row, kept only because a listed file imports it:
`configs/payments.ts`, `configs/permissions.ts`, `models/Users.ts`,
`types/couponLocks.ts`, `types/permission.ts`, `types/user.ts`, `P/page.tsx`,
`P/_components/ProfileDropdown.tsx` (not ported — AccountSwitcher owns it).
