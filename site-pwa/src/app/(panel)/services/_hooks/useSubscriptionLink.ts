"use client";

import { useState } from "react";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi } from "@/lib/billing-api";
import { copyText } from "../../_lib/clipboard";

export interface SubscriptionLinkState {
  /** The link billing answered for this row, or `null` until something asks. */
  link: string | null;
  isReading: boolean;
  copied: boolean;
  /** The clipboard refused: the link is shown to select by hand. */
  showLink: boolean;
  isResetting: boolean;
  resetDone: boolean;
  error: { message: string; ref?: string } | null;
  /**
   * The owner reset this link as often as a day allows (F-114-e-d): how many,
   * and when the next reset is — an ISO instant. `null` until billing says so.
   */
  resetLimited: { limit: number; nextAt: string } | null;
  /** The link, read once per row; `null` after a refusal, which is on screen. */
  readLink: () => Promise<string | null>;
  copy: () => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * One Grant's subscription link (F-114-e-c), shared by the row's "connect"
 * (copy, QR) and "details" (reset) halves, so a reset in one replaces the
 * link the other shows.
 *
 * **The link is asked for, never carried.** The list answers no token
 * (`billing/contract.gift.md`); the link is read from its own route the first
 * time this row needs it and held only while the page is up. Billing keeps
 * the token sealed and answers the same link every time (ADR-0085).
 *
 * **Reset never retries**, and a refusal changes nothing: it destroys the link
 * the user's app already holds. The caller asks first.
 */
export function useSubscriptionLink(grantId: string): SubscriptionLinkState {
  const toMessage = useApiErrorMessage();
  const [link, setLink] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);
  const [resetLimited, setResetLimited] = useState<{ limit: number; nextAt: string } | null>(null);

  function refused(e: unknown) {
    // Billing's own sentence, laid out (`contract.errors.md`) — `link_not_kept`
    // tells an older Grant's user to reset once.
    console.error(e);
    setError({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined });
  }

  async function readLink(): Promise<string | null> {
    if (link) return link;
    setError(null);
    setIsReading(true);
    try {
      const { subscriptionUrl } = await billingApi.subscriptionLink(grantId);
      setLink(subscriptionUrl);
      return subscriptionUrl;
    } catch (e) {
      refused(e);
      return null;
    } finally {
      setIsReading(false);
    }
  }

  async function copy() {
    if (isReading) return;
    const url = await readLink();
    if (!url) return;
    if (await copyText(url)) setCopied(true);
    // No clipboard (an insecure origin, an old in-app browser).
    else setShowLink(true);
  }

  async function reset() {
    if (isResetting) return;
    setError(null);
    setIsResetting(true);
    try {
      const { subscriptionUrl } = await billingApi.resetSubscriptionLink(grantId);
      // The old link is dead inside billing's transaction, so it must not stay
      // on screen to be copied.
      setLink(subscriptionUrl);
      setResetDone(true);
      setCopied(false);
    } catch (e) {
      // Nothing was reset, so whatever is on screen is still the link.
      const limited = resetLimitOf(e);
      if (limited) setResetLimited(limited);
      else refused(e);
    } finally {
      setIsResetting(false);
    }
  }

  return { link, isReading, copied, showLink, isResetting, resetDone, error, resetLimited, readLink, copy, reset };
}

/**
 * `link_reset_limit` (F-114-e-d) with the figures it carries: the limit and
 * when the next reset is allowed, as epoch ms (`facts` carries no text). Any
 * other refusal, or one missing a figure, is `null` and read as billing's
 * sentence instead.
 */
export function resetLimitOf(e: unknown): { limit: number; nextAt: string } | null {
  if (!(e instanceof ApiError) || e.reason !== "link_reset_limit") return null;
  const { limit, nextAtMs } = e.facts;
  if (typeof limit !== "number" || typeof nextAtMs !== "number" || !Number.isFinite(nextAtMs)) return null;
  return { limit, nextAt: new Date(nextAtMs).toISOString() };
}
