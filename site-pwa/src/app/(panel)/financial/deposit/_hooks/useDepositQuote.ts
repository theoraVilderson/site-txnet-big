"use client";

import { useCallback, useEffect, useState } from "react";
import {
  billingApi,
  type DepositGateway,
  type DepositQuote,
  type DepositQuoteBody,
} from "@/lib/billing-api";
import { toCents } from "../_lib/deposit-amount";

/**
 * How long the page waits after the last change before pricing it.
 *
 * A quote at an automatic-fee gateway is a call to a bank, and the route is
 * limited to 60 per 900s per user (`billing/contract.deposit.md`), so a quote
 * per keystroke would spend a user's budget for them and then show them a 429.
 * Legacy debounced the same call by 600ms; this is the same idea with the
 * reason written down.
 */
export const QUOTE_DEBOUNCE_MS = 500;

export interface DepositInputs {
  gateway: DepositGateway | null;
  /** Exactly what is in the amount box — a decimal string, or `""`. */
  amount: string;
  /** The codes the user has added, in the order they added them. */
  codes: string[];
}

export interface DepositQuoteState {
  /**
   * The bill **for the inputs currently on screen**, or `null` when there is
   * none: nothing to price yet, a read in flight, or a read that failed.
   */
  quote: DepositQuote | null;
  /** A price for these inputs is being worked out. The summary shows its own placeholder. */
  isQuoting: boolean;
  /** What the quote failed with, already in the user's language, or `null`. */
  error: unknown;
  retry: () => void;
}

/**
 * The whole question as one string: the body the route will be sent, plus the
 * retry counter. Two renders with the same string are the same question, and
 * the effect can rebuild the body from it — so a new object holding the same
 * inputs costs no second call, and nothing has to be read from a ref mid-render.
 */
function quoteKey(inputs: DepositInputs, asked: number): string | null {
  const cents = toCents(inputs.amount);
  if (!inputs.gateway || cents === null || cents <= 0) return null;
  const body: DepositQuoteBody = {
    gatewayId: inputs.gateway.id,
    source: inputs.gateway.source,
    amount: inputs.amount,
    couponCodes: inputs.codes,
  };
  return JSON.stringify([body, asked]);
}

/**
 * The top-up bill (F-093-e), priced by `billing` and by nothing here.
 *
 * **The inputs are the key, and a quote belongs to the key it was asked for.**
 * The moment the amount, the gateway or the codes change, the previous
 * breakdown stops being an answer to anything on screen and is dropped — not
 * kept warm under the new inputs until a new one arrives. That is the rule the
 * whole page hangs off: legacy priced the bill in the browser *and* on the
 * server, and the two drifted (F-0612); showing a stale server bill under new
 * inputs re-creates the same disagreement with a delay on it.
 *
 * A rejected coupon is part of a successful answer, never a failure: the quote
 * comes back without that code and carries the translated sentence saying why
 * (`billing/contract.deposit.md`). Only a refusal of the whole quote — a 400 on
 * the range, a 503 on the gateway, a 429 from the limiter — lands in `error`,
 * and each of those arrives already translated.
 *
 * Racing is handled the way `useWalletBalance` and `useFinancialPage` handle
 * it: one effect keyed to the question, with an `alive` flag, so a slow answer
 * to abandoned inputs cannot land on top of a fast answer to the current ones.
 */
export function useDepositQuote(inputs: DepositInputs): DepositQuoteState {
  const [asked, setAsked] = useState(0);
  const retry = useCallback(() => setAsked((n) => n + 1), []);

  const key = quoteKey(inputs, asked);

  // What landed, and which question it answered. Held as one value so a quote
  // and the inputs it belongs to can never be set apart from each other.
  const [landed, setLanded] = useState<{ key: string; quote: DepositQuote | null; error: unknown } | null>(
    null,
  );
  const current = landed && landed.key === key ? landed : null;

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    const [body] = JSON.parse(key) as [DepositQuoteBody, number];
    const timer = setTimeout(async () => {
      try {
        const quote = await billingApi.depositQuote(body);
        if (alive) setLanded({ key, quote, error: null });
      } catch (e) {
        if (alive) setLanded({ key, quote: null, error: e });
      }
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key]);

  return {
    quote: current?.quote ?? null,
    isQuoting: key !== null && current === null,
    error: current?.error ?? null,
    retry,
  };
}
