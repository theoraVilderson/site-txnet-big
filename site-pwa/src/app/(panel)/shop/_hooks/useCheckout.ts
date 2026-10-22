"use client";

import { useRef, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type InvoicePaid, type ShopInvoice } from "@/lib/billing-api";
import { forgetReturnInvoice, meteredCapOf, shortfallOf } from "../_lib/shop";

const S = FrontendI18nKeys.common.shop;

export interface CheckoutOptions {
  /** An invoice already made — a return from a top-up (`?invoice=`). */
  initial: ShopInvoice | null;
  /** The price before any code, as listed; `null` when only the invoice knows it. */
  listed: string | null;
  /** Makes the invoice for these codes; `null` = the invoice on screen is the only one, its codes fixed. */
  makeInvoice: ((codes: string[]) => Promise<ShopInvoice>) | null;
  onPaid: (paid: InvoicePaid) => void;
}

/**
 * One invoice's checkout (panel-web `contract.shop.md` rules 4–7): the codes,
 * the invoice they make, and one pay from the wallet. The shop's checkout and
 * My services' renewal sheet (`contract.renewal.md` rule 5) both run on it, so
 * a code, a shortfall or a refusal reads the same in either.
 *
 * **One press pays once**: the claim is taken on the click, before any
 * request, and covers the invoice it may have to make first. **An invoice
 * replaced is cancelled first** — a code it holds counts as a use for its 30
 * minutes, so a new invoice beside it would refuse that code.
 */
export function useCheckout({ initial, listed, makeInvoice, onPaid }: CheckoutOptions) {
  const { t } = useLocale();
  const messageFor = useApiErrorMessage();
  const busy = useRef(false);
  const [isBusy, setIsBusy] = useState(false);
  const [invoice, setInvoice] = useState<ShopInvoice | null>(initial);
  const [codes, setCodes] = useState<string[]>(initial ? initial.applied.map((a) => a.code) : []);
  const [rejected, setRejected] = useState<NonNullable<ShopInvoice["rejected"]>>([]);
  const [draft, setDraft] = useState("");
  const [missing, setMissing] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState(false);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);

  /** Runs one step under the claim: a second press, or a code typed mid-pay, is ignored. */
  async function claimed(step: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setIsBusy(true);
    setError(null);
    setMissing(null);
    try {
      await step();
    } catch (e) {
      // Past the limit (F-118-ao): the numbers and the way to more, not only billing's sentence.
      const capped = meteredCapOf(e);
      const message = capped ? t("common", S.meteredCap, { open: capped.open, cap: capped.cap }) : messageFor(e);
      setError({ message, ref: e instanceof ApiError ? e.ref : undefined });
    }
    busy.current = false;
    setIsBusy(false);
  }

  /** Gives the held codes back before anything replaces or leaves this invoice. Best effort: its clock frees them anyway. */
  async function release(current: ShopInvoice | null) {
    if (!current || current.status !== "pending") return;
    await billingApi.cancelInvoice(current.id).catch(() => {});
    forgetReturnInvoice();
  }

  /** A new invoice for these codes, replacing the one on screen. No code left means no invoice until the pay. */
  const requote = (next: string[], make = makeInvoice) =>
    claimed(async () => {
      await release(invoice);
      setInvoice(null);
      setPriceChanged(false);
      setRejected([]);
      setCodes(next);
      if (next.length === 0 || !make) return;
      const made = await make(next);
      setInvoice(made);
      setCodes(made.applied.map((a) => a.code));
      setRejected(made.rejected ?? []);
    });

  const addCode = () => {
    const code = draft.trim().toUpperCase();
    setDraft("");
    if (code && !codes.includes(code)) void requote([...codes, code]);
  };

  const pay = () =>
    claimed(async () => {
      let current = invoice;
      if (!current) {
        if (!makeInvoice) return;
        current = await makeInvoice(codes);
        setInvoice(current);
        // What was on screen was the price alone: a different total is shown, not paid.
        if (listed === null || current.total !== listed) {
          setPriceChanged(listed !== null && current.amount !== listed);
          return;
        }
      }
      try {
        onPaid(await billingApi.payInvoice(current.id));
      } catch (e) {
        const short = shortfallOf(e);
        if (short) {
          setMissing(short);
          return;
        }
        // Expired, already paid or cancelled since it was read: read it again,
        // so the status on screen is billing's and the button goes with it.
        if (e instanceof ApiError && e.status === 409) {
          const id = current.id;
          billingApi.invoice(id).then(setInvoice, () => {});
        }
        throw e;
      }
    });

  return {
    invoice,
    codes,
    rejected,
    draft,
    setDraft,
    missing,
    priceChanged,
    error,
    isBusy,
    /** Codes may be typed: there is a way to make the invoice they need. */
    takesCodes: makeInvoice !== null,
    open: invoice === null || invoice.status === "pending",
    addCode,
    removeCode: (code: string) => void requote(codes.filter((c) => c !== code)),
    pay,
    /**
     * What is being bought changed: the pending invoice goes, and the codes are
     * asked again of `make` — the new choice's maker, since this render's
     * `makeInvoice` is still the old one's.
     */
    restart: (make = makeInvoice) => void requote(codes, make),
    /** Leaving the checkout: the pending invoice is given up. */
    leave: () => void release(invoice),
  };
}

export type Checkout = ReturnType<typeof useCheckout>;
