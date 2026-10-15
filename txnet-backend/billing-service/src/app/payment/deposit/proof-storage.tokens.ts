/**
 * The DI tokens of a transfer receipt's storage and scanner (F-805-a), bound by
 * `deposit-proof.module.ts`. Their own file so `ManualConfirmService` reads the
 * receipt (F-805-b) without importing the proof service — whose reviewer notice
 * imports the confirm controller, which imports `ManualConfirmService`: a cycle
 * that left the token `undefined` at boot.
 */
export const PROOF_OBJECT_DRIVER = Symbol('PROOF_OBJECT_DRIVER');
export const PROOF_VIRUS_SCANNER = Symbol('PROOF_VIRUS_SCANNER');
