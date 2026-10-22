"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lightbulb, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { aiApi, type SuggestionCard as Card, type SuggestionCardType } from "@/lib/ai-api";
import { billingApi, type GrantRow, type RenewalPlan } from "@/lib/billing-api";
import { panelShopVariantPath } from "@/lib/routes";
import { formatMoney } from "../../_lib/money";
import { Button } from "../../_components/kit";
import { serviceName } from "../_lib/my-services";
import { RenewalSheet } from "./RenewalSheet";

const S = FrontendI18nKeys.common.myServices.suggestion;

/** Each type's words — exhaustive, so a type added to the card without them does not compile. */
const TYPE_TEXT: Record<SuggestionCardType, { body: string; cta: string }> = {
  renew: S.renew,
  resize_up: S.resize_up,
  resize_down: S.resize_down,
};

const DAY_MS = 86_400_000;

// Billing's `GET /gift/grants` answers at most this many a page; the renewal's Grant is looked for in one read.
const GRANTS_READ_MAX = 100;

/** A plan as the card names and prices it — a shop offer's or a renewal plan's fields. */
type Plan = Pick<RenewalPlan, "variantId" | "sku" | "nameKey" | "price" | "currencyCode">;

type Shown = { card: Card; text: { body: string; cta: string }; plan: Plan; from: Plan | null };

/**
 * The plan the card names, priced now: a `renew` as **this Grant's renewal**
 * (F-305-h, billing's renewal plans — the shop would sell a new Grant), a
 * resize as the shop's. `null` = the plan is not offered: no card.
 */
async function readPlan(card: Card): Promise<{ plan: Plan; from: Plan | null } | null> {
  if (card.actionType === "renew") {
    const { plans } = await billingApi.renewalPlans(card.grantId);
    const plan = plans.find((p) => p.variantId === card.variantId);
    return plan ? { plan, from: null } : null;
  }
  const offers = await billingApi.shopOffers();
  const plan = offers.find((o) => o.variantId === card.variantId);
  return plan ? { plan, from: offers.find((o) => o.variantId === card.fromVariantId) ?? null } : null;
}

/**
 * The user's current AI suggestion (F-038-h, ADR-0109 point 11), at the top of
 * My services: labelled as one (F-1509), with **one** call to action — the
 * shop opened on the plan it names (F-1507) — a close, and "don't show this
 * again" (F-1505). Both of those are controls, not calls to action.
 *
 * **A `renew` leads to the renewal** (F-305-h): its call opens the Grant's
 * renewal sheet with the plan named already picked — the Grant from the page's
 * rows, or read from the list when it is on another page.
 *
 * **The plan and its price are billing's, read now** — the engine's price
 * may be days old, and a plan no longer offered shows no card, as the
 * bot tells none (`plan_unavailable`). Names come from the page's catalog texts.
 *
 * **Nothing shows unless everything was read.** A pitch is never worth an
 * error line: a failed read of ai or the shop renders nothing. A refused
 * close or opt-out keeps the card and says so in one line.
 */
export function SuggestionCard({ texts, rows }: { texts: Record<string, string>; rows: readonly GrantRow[] }) {
  const { lang, t } = useLocale();
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [renewing, setRenewing] = useState<GrantRow | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { suggestion } = await aiApi.current();
        const text = suggestion ? TYPE_TEXT[suggestion.actionType as SuggestionCardType] : undefined;
        if (!suggestion || !text) return;
        const read = await readPlan(suggestion);
        if (!read || !alive) return;
        setShown({ card: suggestion, text, ...read });
      } catch {
        // No card: see the comment above.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!shown) return null;
  const { card, text, plan, from } = shown;
  const name = (o: Plan) => texts[o.nameKey] || o.sku;
  const days = card.deadline ? Math.max(1, Math.ceil((new Date(card.deadline).getTime() - Date.now()) / DAY_MS)) : null;
  const vars = {
    plan: name(plan),
    from: from ? name(from) : name(plan),
    price: formatMoney(plan.price, plan.currencyCode, { lang, t }),
    days: days ?? "",
  };

  const act = async (call: (actionId: string) => Promise<unknown>) => {
    setBusy(true);
    setFailed(false);
    try {
      await call(card.actionId);
      setShown(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  // The Grant's row as the sheet takes it; one no longer listed says so, as a refused close does.
  const openRenewal = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const row =
        rows.find((r) => r.id === card.grantId) ??
        (await billingApi.grants(1, GRANTS_READ_MAX, "current")).rows.find((r) => r.id === card.grantId);
      if (row) setRenewing(row);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const cta = t("common", text.cta, { plan: vars.plan });

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-leaf-bg text-primary">
          <Lightbulb size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-primary">{t("common", S.label)}</p>
          <p className="mt-1 text-sm text-text-primary">{t("common", text.body, vars)}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(aiApi.dismiss)}
          aria-label={t("common", S.dismiss)}
          className="shrink-0 rounded-xl p-1.5 text-text-secondary hover:bg-bg-inner disabled:opacity-50"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        {card.actionType === "renew" ? (
          <Button variant="primary" disabled={busy} onClick={() => void openRenewal()}>
            {cta}
          </Button>
        ) : (
          <Link
            href={panelShopVariantPath(plan.variantId)}
            className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-bold text-on-accent hover:brightness-110"
          >
            {cta}
          </Link>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(aiApi.optOut)}
          className="text-xs font-bold text-text-secondary underline disabled:opacity-50"
        >
          {t("common", S.optOut)}
        </button>
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-xs font-medium text-error">
          {t("common", S.failed)}
        </p>
      )}
      {renewing && (
        <RenewalSheet
          row={renewing}
          name={serviceName(texts, renewing) ?? ""}
          initialPlan={plan.variantId}
          onClose={() => setRenewing(null)}
        />
      )}
    </section>
  );
}
