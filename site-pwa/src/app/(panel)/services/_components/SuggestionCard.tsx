"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lightbulb, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { aiApi, type SuggestionCard as Card, type SuggestionCardType } from "@/lib/ai-api";
import { billingApi, type ShopOffer } from "@/lib/billing-api";
import { panelShopVariantPath } from "@/lib/routes";
import { formatMoney } from "../../_lib/money";

const S = FrontendI18nKeys.common.myServices.suggestion;

/** Each type's words — exhaustive, so a type added to the card without them does not compile. */
const TYPE_TEXT: Record<SuggestionCardType, { body: string; cta: string }> = {
  renew: S.renew,
  resize_up: S.resize_up,
  resize_down: S.resize_down,
};

const DAY_MS = 86_400_000;

type Shown = { card: Card; text: { body: string; cta: string }; plan: ShopOffer; from: ShopOffer | null };

/**
 * The user's current AI suggestion (F-038-h, ADR-0109 point 11), at the top of
 * My services: labelled as one (F-1509), with **one** call to action — the
 * shop opened on the plan it names (F-1507) — a close, and "don't show this
 * again" (F-1505). Both of those are controls, not calls to action.
 *
 * **The plan and its price are the shop's, read now** — the engine's price
 * may be days old, and a plan the shop no longer offers shows no card, as the
 * bot tells none (`plan_unavailable`). Names come from the page's catalog texts.
 *
 * **Nothing shows unless everything was read.** A pitch is never worth an
 * error line: a failed read of ai or the shop renders nothing. A refused
 * close or opt-out keeps the card and says so in one line.
 */
export function SuggestionCard({ texts }: { texts: Record<string, string> }) {
  const { lang, t } = useLocale();
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { suggestion } = await aiApi.current();
        const text = suggestion ? TYPE_TEXT[suggestion.actionType as SuggestionCardType] : undefined;
        if (!suggestion || !text) return;
        const offers = await billingApi.shopOffers();
        const plan = offers.find((o) => o.variantId === suggestion.variantId);
        if (!plan || !alive) return;
        setShown({ card: suggestion, text, plan, from: offers.find((o) => o.variantId === suggestion.fromVariantId) ?? null });
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
  const name = (o: ShopOffer) => texts[o.nameKey] || o.sku;
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
        <Link
          href={panelShopVariantPath(plan.variantId)}
          className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-bold text-on-accent hover:brightness-110"
        >
          {t("common", text.cta, { plan: vars.plan })}
        </Link>
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
    </section>
  );
}
