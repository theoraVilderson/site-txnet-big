// A top-up: its gateways, quote, start and abandon (F-093-e), and a gift code redeemed (F-093-g).
import { call } from "./client";

/**
 * What `POST /gift/redeem` answers (`billing/contract.gift.md`).
 *
 * `balance` is the wallet's balance **after** the credit, written by the same
 * transaction that appended the ledger row — so it is a balance billing
 * answered, not one this app worked out. Nothing on this side adds `credited`
 * to a figure it is holding: that is exactly the legacy bug F-093-g does not
 * port, where a *refused* code still added an `undefined` amount to the store
 * and showed success over a balance of `NaN`.
 */
export interface GiftCredit {
  /** Absent on an answer from before F-502-l-b; a credit either way. */
  kind?: "wallet_credit";
  /** The code as stored, which is the trimmed, upper-cased form of what was typed. */
  code: string;
  /** In `currencyCode`, a decimal string. Always `> 0` — a zero-value coupon raises server-side. */
  credited: string;
  /** The balance after the credit. In `currencyCode`, a decimal string. */
  balance: string;
  /** What `credited` and `balance` are in: the code's own, which the wallet's matches (F-116-h3). */
  currencyCode: string;
}

/**
 * A free-service code (F-502-l-b): a Grant, and no token — the link is My
 * services' to show, as often as asked (F-114-e-c, ADR-0085).
 */
export interface GiftGrant {
  kind: "free_grant";
  code: string;
  grant: { id: string; variantId: string | null; startsAt: string; endsAt: string | null; featureKeys: string[] };
}

export type GiftRedemption = GiftCredit | GiftGrant;

/**
 * One gateway the user may pay through, as `GET /deposit/gateways` answers it
 * (`billing/contract.deposit.md`). Only gateways that are usable are listed —
 * active, verified, with a driver and a merchant id in the vault — so this app
 * never has to explain why an offered gateway refused the payment.
 */
export interface DepositGateway {
  id: string;
  /**
   * Which table the id is from. It travels back on every quote and start,
   * because a platform gateway and a tenant one can share an id and only the
   * pair identifies a row (ADR-0006, D-25).
   */
  source: "platform" | "tenant";
  displayName: string;
  /** The driver behind it (`zarinpal`, …). Shown as the logo, never branched on. */
  providerName: string;
  category: string;
  /** In `currencyCode`, decimal strings. The gateway's own range — the amount box's bounds; `null` is no limit on that side. */
  minAmount: string | null;
  maxAmount: string | null;
  /** Off or not yet verified: shown only to someone who may manage gateways, so they can test it. */
  testing: boolean;
  /**
   * Quick amounts (F-092-v): the gateway's own list, else the tenant's default,
   * already inside the range. Empty means none was configured.
   */
  presets: string[];
  /** The gateway's own currency: what its range and presets are in (F-116-h2). */
  currencyCode: string;
}

/** A coupon that priced into the quote. `discount` is what this code took, after the ones before it. */
export interface QuotedCoupon {
  code: string;
  discount: string;
}

/**
 * A code that did not price in. **Not an error**: the quote goes on without it,
 * so a typo cannot hide the rest of the breakdown. `message` is a sentence
 * billing has already translated, one per `reason` — this app shows it as it
 * arrived and branches on no reason code (`contract.errors.md`).
 */
export interface RejectedCoupon {
  code: string;
  reason: string;
  message: string;
}

/**
 * The whole bill for one set of inputs (`POST /deposit/quote`).
 *
 * **Every number here is `priceAtGateway`'s and the panel derives none of
 * them** — not the total, not the discount, not the balance afterwards
 * (F-0612). Legacy computed the same bill in the browser and again on the
 * server, and the two drifted.
 */
export interface DepositQuote {
  gatewayId: string;
  source: "platform" | "tenant";
  /** What the user asked to top up with, echoed back. */
  amount: string;
  /** The payment's currency: what every amount here but `charge` is in (F-116-h2). */
  currencyCode: string;
  coupons: QuotedCoupon[];
  rejected: RejectedCoupon[];
  discount: string;
  /**
   * What the payable was raised by to clear the gateway's minimum, and never a
   * charge: it is credited to the wallet too, so `credited` already carries it.
   */
  gap: string;
  fee: string;
  /**
   * Tax on top of the basis (ADR-0076), already inside `payable`. `0.00` when
   * untaxed; `taxRatePercent` is the rate billing applied — the gateway's, else
   * the tenant default — or `null` for none.
   */
  tax: string;
  taxRatePercent: string | null;
  /** What the card is charged, in `currencyCode`. `0.00` on the free path. */
  payable: string;
  /** What lands in the wallet — the amount plus the adjustment gap. */
  credited: string;
  /** Fully discounted: nothing reaches a gateway and the credit is immediate. */
  free: boolean;
  /**
   * What the gateway itself will be asked for, in its own currency and minor
   * units, at the rate that priced this quote (ADR-0019). `null` on the free
   * path. Shown beside the payable so a rial gateway's figure is not a surprise
   * on the bank's page.
   */
  charge: { currency: string; decimals: number; amountMinor: string } | null;
}

/** The body all three of the paying routes take — the same one, so they cannot drift. */
export interface DepositQuoteBody {
  gatewayId: string;
  source: "platform" | "tenant";
  amount: string;
  couponCodes: string[];
}

/**
 * What `POST /deposit/start` answers. The payment row exists and its coupons
 * are held by the time this lands (`billing/contract.deposit.md`).
 */
export interface DepositStarted {
  paymentId: string;
  free: boolean;
  /** Where to send the browser. `null` on the free path, where nothing was minted. */
  redirectUrl: string | null;
  /**
   * An in-chat gateway started inside a Mini App (F-104-q): the link the
   * messenger's `openInvoice` takes. `null` everywhere else — a browser is
   * never offered such a gateway.
   */
  invoiceLink: string | null;
  amount: string;
  discount: string;
  fee: string;
  tax: string;
  taxRatePercent: string | null;
  payable: string;
  credited: string;
  /** The wallet balance after a free top-up credited it; `null` when nothing was credited. */
  balance: string | null;
  /** What every amount here is in (F-116-h3, ADR-0098): the answer's own, never assumed. */
  currencyCode: string;
}

/** Top-up and gift-code calls — spread into `billingApi` (`lib/billing-api.ts`). */
export const depositCalls = {
  /**
   * The gateways this user may pay through (F-093-e). Unusable ones are not in
   * the list at all, so the selector needs no "why is this greyed out" state.
   */
  async depositGateways(): Promise<DepositGateway[]> {
    return call<DepositGateway[]>("/deposit/gateways", { method: "GET" });
  },

  /**
   * Price one set of inputs. It reserves and writes nothing, so it is safe to
   * call whenever the amount, the gateway or the codes change — which is what
   * the page does, debounced.
   */
  async depositQuote(body: DepositQuoteBody): Promise<DepositQuote> {
    return call<DepositQuote>("/deposit/quote", { method: "POST", body: JSON.stringify(body) });
  },

  /**
   * Start the payment the quote described, with **the quote's own body**: the
   * server re-prices from the same inputs by the same code, and a client never
   * sends back a number it was shown (F-0612).
   *
   * A coupon that can no longer be held is a 409 carrying a translated
   * sentence, and nothing was written — the page re-quotes and the breakdown
   * comes back without it.
   */
  async depositStart(body: DepositQuoteBody): Promise<DepositStarted> {
    return call<DepositStarted>("/deposit/start", { method: "POST", body: JSON.stringify(body) });
  },

  /**
   * The Mini App's invoice sheet closed without paying (F-093-q): tell billing,
   * so the payment's coupon holds come back now instead of at the end of its
   * 15-minute clock and the one-use code still works on the next try.
   *
   * Every outcome is a 200 verdict there is nothing to show — billing refuses
   * a payment pre-checkout has already approved, because the messenger may
   * hold the money. A network failure here costs only the wait it saved, so
   * the caller lets it go rather than telling the payer about it.
   */
  async depositAbandon(paymentId: string): Promise<{ status: string }> {
    return call<{ status: string }>(`/deposit/${paymentId}/abandon`, { method: "POST" });
  },

  /**
   * Redeem a gift code (F-093-g), crediting the wallet in one transaction.
   *
   * Every refusal is a **409** carrying a sentence billing has already
   * translated — "this is a discount code, enter it when you top up", and four
   * others — so it arrives as an `ApiError` whose `message` goes straight on
   * screen (`contract.errors.md`). There is no reason code to branch on here,
   * and deliberately so: each message already names the box the code belongs
   * in, which is the job a `reason` would otherwise be doing in this client.
   *
   * The route is rate-limited far below the read routes (10 per 900s), because
   * it is the only thing that says whether a given code exists. A caller that
   * retried on the user's behalf would spend that budget for them.
   */
  async redeemGift(code: string): Promise<GiftRedemption> {
    return call<GiftRedemption>("/gift/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },
};
