/**
 * The permission to finish an open payment by hand (F-092-z, ADR-0044 decision 6).
 * SuperAdmin holds it as `*`; a staff group gives it. Its own file because the
 * guard and the reviewers told of a transfer's proof (F-805-b) both read it,
 * and the guard's controller sits on the service those reviewers feed.
 */
export const PAYMENT_CONFIRM_MANUAL = 'payment.confirm_manual';
