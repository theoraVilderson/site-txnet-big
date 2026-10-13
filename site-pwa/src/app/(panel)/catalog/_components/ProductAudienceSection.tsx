"use client";

import { useEffect, useState } from "react";
import { Check, Globe2, UsersRound } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { UserGroup } from "@/lib/auth-api";
import type { CatalogProduct } from "@/lib/catalog-api";
import { Button, Checkbox } from "../../_components/kit";
import { RadioCards } from "../../_components/kit/choice";
import { Skeleton } from "../../_components/kit/Skeleton";
import { audienceBody, audienceChanged, modeOf, type AudienceMode } from "../../gateways/_lib/audience";
import { CATALOG_KEYS } from "../_lib/catalog-form";
import { useCatalogSurface } from "../_lib/surface";
import { useMessage } from "./catalog-ui";

const A = CATALOG_KEYS.audience;

/**
 * Whether this screen sets the product's audience (PT-1-b): it is the
 * surface's own tenant's. The platform owner's `/catalog` lists every tenant's
 * products, but its groups are the platform's — a reseller's product is given
 * its audience from that reseller's workspace, with that reseller's groups.
 */
export const ownsAudience = (product: Pick<CatalogProduct, "tenantId">, surfaceTenantId: string | null, myTenantId: string | null): boolean =>
  product.tenantId === (surfaceTenantId ?? myTenantId);

/**
 * Who may buy this product (PT-1-b, ADR-0142 (4)), a section of the product
 * sheet with its own save: billing replaces the set whole on its own route.
 * Every user, or only users in at least one of the chosen groups — the shop,
 * a direct link and an issue by hand all ask it. A service already sold stays.
 */
export function ProductAudienceSection({ product, onSaved }: { product: CatalogProduct; onSaved: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useMessage();
  const surface = useCatalogSurface();
  const [saved, setSaved] = useState<string[]>(product.userGroupIds ?? []);
  const [mode, setMode] = useState<AudienceMode>(modeOf(saved));
  const [selected, setSelected] = useState<string[]>(saved);
  const [groups, setGroups] = useState<UserGroup[] | null>(null);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    surface
      .groups()
      .then((g) => alive && setGroups(g))
      .catch(() => alive && setGroupsFailed(true));
    return () => {
      alive = false;
    };
  }, [surface]);

  // A limited product with no group would be sold to nobody: that is switching it off, which is its own control.
  const pickOne = mode === "groups" && selected.length === 0;
  const dirty = audienceChanged(saved, mode, selected);
  const touch = () => {
    setDone(false);
    setFailure(null);
  };

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const { userGroupIds } = await surface.api.setAudience(product.id, audienceBody(mode, selected));
      setSaved(userGroupIds);
      setDone(true);
      await onSaved();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-card-border p-3">
      <header className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-[var(--leaf-bg)] text-primary">
          <UsersRound size={16} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-text-primary">{t("common", A.title)}</h3>
          <p className="text-[11px] leading-5 text-text-secondary">{t("common", A.subtitle)}</p>
        </div>
      </header>

      <RadioCards
        ariaLabel={t("common", A.title)}
        value={mode}
        onChange={(v) => {
          setMode(v);
          touch();
        }}
        options={[
          { value: "everyone", label: t("common", A.everyone), description: t("common", A.everyoneHint), icon: Globe2 },
          { value: "groups", label: t("common", A.groups), description: t("common", A.groupsHint), icon: UsersRound },
        ]}
      />

      {mode === "groups" && (
        <div className="rounded-xl border border-card-border bg-[var(--bg-inner)] p-3">
          {groupsFailed ? (
            <p role="alert" className="text-xs font-bold text-error">
              {t("common", A.groupsFailed)}
            </p>
          ) : groups === null ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-32" />
            </div>
          ) : groups.length === 0 ? (
            <p className="text-xs leading-6 text-text-secondary">{t("common", A.noGroups)}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {groups.map((g) => (
                <li key={g.id}>
                  <Checkbox
                    checked={selected.includes(g.id)}
                    onChange={(on) => {
                      setSelected((s) => (on ? [...s, g.id] : s.filter((x) => x !== g.id)));
                      touch();
                    }}
                    label={g.name}
                    hint={t("common", A.members, { count: g.userCount })}
                  />
                </li>
              ))}
            </ul>
          )}
          {pickOne && groups !== null && groups.length > 0 && <p className="mt-2 text-xs font-bold text-error">{t("common", A.pickOne)}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {failure && (
          <p role="alert" className="me-auto text-xs font-bold text-error">
            {failure}
          </p>
        )}
        {done && !dirty && (
          <p role="status" className="me-auto inline-flex items-center gap-1 text-xs font-bold text-success">
            <Check size={14} aria-hidden />
            {t("common", A.saved)}
          </p>
        )}
        <Button variant="primary" size="sm" disabled={!dirty || saving || pickOne} loading={saving} onClick={() => void save()}>
          {t("common", A.save)}
        </Button>
      </div>
    </section>
  );
}
