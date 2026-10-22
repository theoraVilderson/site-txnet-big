"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { selfMoveSettingsApi, type SelfMoveSettingsView } from "@/lib/billing-api";
import {
  MAX_SELF_MOVE_COOLDOWN_HOURS,
  SELF_MOVE_KEYS as K,
  SELF_MOVE_LAYER_KEYS,
  inheritedOf,
  ownOf,
  selfMoveBodyOf,
  selfMoveChoiceOf,
  type SelfMoveChoice,
} from "../_lib/self-move-settings";
import { Alert, Button, Field, Input, RadioCards } from "./kit";

/**
 * Whether a tenant's users move their own config to another server, and how
 * long they wait between two moves (F-410-f over billing F-410-a): the
 * tenant's layer (`productId` null, on its settings page) or one product's
 * override (on the product's sheet in the catalog). Each value is inherited —
 * named with billing's value and the layer it came from — or this layer's own;
 * a save sends both and shows the view billing answered.
 */
export function SelfMoveSettings({
  tenantId,
  productId,
  errorMessage,
}: {
  tenantId: string;
  productId: string | null;
  /** The sentence for a refused read or save, in the surface's words. */
  errorMessage: (e: unknown) => string;
}) {
  const { t } = useLocale();
  const api = useMemo(() => selfMoveSettingsApi(tenantId), [tenantId]);
  const [view, setView] = useState<SelfMoveSettingsView | null>(null);
  const [choice, setChoice] = useState<SelfMoveChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // A refusal is kept as it came and worded at render, so the read needs no `errorMessage` dependency.
  const [error, setError] = useState<{ refused: unknown } | { key: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.read().then(
      (v) => {
        if (!live) return;
        setView(v);
        setChoice(selfMoveChoiceOf(ownOf(v, productId)));
      },
      (e) => live && setError({ refused: e }),
    );
    return () => {
      live = false;
    };
  }, [api, productId]);

  const set = (patch: Partial<SelfMoveChoice>) => {
    setChoice((c) => c && { ...c, ...patch });
    setSaved(false);
    setError(null);
  };

  const save = async () => {
    if (!view || !choice || busy) return;
    const next = selfMoveBodyOf(choice, ownOf(view, productId));
    if (!next.ok) {
      setError({ key: next.error });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const v = productId === null ? await api.setTenant(next.body) : await api.setProduct(productId, next.body);
      setView(v);
      setChoice(selfMoveChoiceOf(ownOf(v, productId)));
      setSaved(true);
    } catch (e) {
      setError({ refused: e });
    } finally {
      setBusy(false);
    }
  };

  const text = productId === null ? K.tenantLayer : K.productLayer;
  const inherited = view && inheritedOf(view, productId);
  const hours = (n: number) => (n === 0 ? t("common", K.noWait) : t("common", K.hours, { hours: n }));
  // Only the hours sentence names a value: billing's ceiling.
  const errorText = (err: NonNullable<typeof error>) =>
    "refused" in err ? errorMessage(err.refused) : t("common", err.key, err.key === K.invalidHours ? { max: MAX_SELF_MOVE_COOLDOWN_HOURS } : undefined);
  const inherit = (layer: keyof typeof SELF_MOVE_LAYER_KEYS, value: string) =>
    t("common", K.inherit, { layer: t("common", SELF_MOVE_LAYER_KEYS[layer]), value });

  return (
    <section aria-label={t("common", text.title)} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <h2 className="text-sm font-bold text-text-primary">{t("common", text.title)}</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", text.hint)}</p>
      </div>
      {view && choice && inherited && (
        <>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-bold text-text-secondary">{t("common", K.enabledLabel)}</p>
            <RadioCards
              ariaLabel={t("common", K.enabledLabel)}
              columns={3}
              value={choice.enabled}
              onChange={(enabled) => set({ enabled })}
              options={[
                { value: "inherit", label: inherit(inherited.enabled.layer, t("common", inherited.enabled.value ? K.on : K.off)) },
                { value: "on", label: t("common", K.on) },
                { value: "off", label: t("common", K.off) },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-bold text-text-secondary">{t("common", K.cooldownLabel)}</p>
            <RadioCards
              ariaLabel={t("common", K.cooldownLabel)}
              value={choice.cooldownMode}
              onChange={(cooldownMode) => set({ cooldownMode })}
              options={[
                { value: "inherit", label: inherit(inherited.cooldownHours.layer, hours(inherited.cooldownHours.value)) },
                { value: "own", label: t("common", K.ownHours) },
              ]}
            />
            {choice.cooldownMode === "own" && (
              <Field label={t("common", K.hoursLabel)} hint={t("common", K.hoursHint)}>
                <Input dir="ltr" inputMode="numeric" value={choice.cooldown} onChange={(e) => set({ cooldown: e.target.value })} />
              </Field>
            )}
          </div>
          {productId === null && view.products.length > 0 && (
            <p className="text-xs text-text-secondary">{t("common", K.overrides, { count: view.products.length })}</p>
          )}
        </>
      )}
      <Button variant="primary" size="sm" disabled={choice === null} onClick={() => void save()} loading={busy}>
        {t("common", K.save)}
      </Button>
      {saved && <p className="text-xs font-bold text-primary">{t("common", K.saved)}</p>}
      {error !== null && <Alert tone="error">{errorText(error)}</Alert>}
    </section>
  );
}
