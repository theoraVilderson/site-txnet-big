"use client";

import { useCallback, useRef, useState } from "react";

/**
 * One press of Pay starts one payment (F-093-r).
 *
 * **The claim is made on the click, not when the call goes out.** `POST
 * /deposit/start` writes a payment row and takes that payment's coupon holds,
 * so a second one is a second row nobody asked for and, with a one-use code in
 * the list, a 409 on the click the payer meant. What is between them is the
 * button's disabled state — and a `useState` set inside the async handler is
 * set one network read too late: every click made while the handler is awaiting
 * (the verifying check, `useVerifyingGuard`) sees the old `false` and starts
 * its own payment.
 *
 * A ref is claimed synchronously in the event handler, which no second click
 * can be scheduled before; the state beside it is only what the button renders.
 * `release()` on every path that comes back to the form — a cancelled warning,
 * a refusal, a sheet that closed unpaid. A path that leaves the page (the trip
 * to the gateway) never releases: a button that came back to life there is a
 * second `start` and a second hold.
 */
export function useStartOnce() {
  const claimed = useRef(false);
  const [isStarting, setStarting] = useState(false);

  /** `true` if this click owns the start; `false` if one is already running. */
  const claim = useCallback(() => {
    if (claimed.current) return false;
    claimed.current = true;
    setStarting(true);
    return true;
  }, []);

  const release = useCallback(() => {
    claimed.current = false;
    setStarting(false);
  }, []);

  return { isStarting, claim, release };
}
