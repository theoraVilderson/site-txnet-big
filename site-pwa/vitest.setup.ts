/// <reference types="vitest/globals" />
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * How long an async assertion may keep polling before it gives up.
 *
 * Testing Library's default is 1000ms, and that is a **ceiling, not a delay**:
 * `waitFor` polls and returns the moment its assertion passes, so raising it
 * costs a passing run nothing at all and only makes a failing one slower to
 * report. Measured 2026-09-21: the deposit page's specs take the same 21s with
 * this at 1000 and at 5000.
 *
 * 1000ms was too tight for anything waiting on a debounce. The deposit page
 * debounces its quote by `QUOTE_DEBOUNCE_MS` (500ms), so a wait for that quote
 * has to cover the timer, a resolved promise and a React render inside 1000ms —
 * which holds on an idle machine and does not hold when the CPU is busy. Under
 * eight busy cores, three of the six specs in `financial/deposit/` failed on
 * exactly this, every run.
 *
 * So the number is not an estimate of how long anything takes. It is how long
 * we are willing to wait before calling a test broken, and it should be far
 * above the slowest honest path rather than just above the usual one.
 */
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
