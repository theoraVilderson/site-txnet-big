"use client";

import { useEffect, useState } from "react";
import { Check, Globe2, UsersRound } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { UserGroup } from "@/lib/auth-api";
import type { AdminGateway } from "@/lib/billing-api";
import { Button, Checkbox } from "../../_components/kit";
import { RadioCards } from "../../_components/kit/choice";
import { Skeleton } from "../../_components/kit/Skeleton";
import { audienceBody, audienceChanged, audienceError, modeOf, type AudienceMode } from "../_lib/audience";
import { useGatewayMessage, type GatewaySurface } from "../_lib/surface";

const A = FrontendI18nKeys.common.gateways.audience;

/**
 * Who sees this gateway (F-102-g-e), a section of the editor with its own save:
 * billing takes it on its own route and replaces the set whole, so it is never
 * mixed into the form's "what changed". Everyone, or only users in at least
 * one of the chosen groups — the owner's own (`surface.groups`). A user outside
 * them is never shown the gateway, and a start that names it is refused as a
 * gateway that does not exist.
 */
export function GatewayAudienceSection({
  gateway,
  surface,
  onSaved,
}: {
  gateway: AdminGateway;
  surface: GatewaySurface;
  onSaved: (userGroupIds: string[]) => void;
}) {
  const { t } = useLocale();
  const errorMessage = useGatewayMessage(surface);
  const [saved, setSaved] = useState<string[]>(gateway.userGroupIds ?? []);
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

  const error = audienceError(mode, selected);
  const dirty = audienceChanged(saved, mode, selected);
  const toggle = (id: string, on: boolean) => {
    setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));
    setDone(false);
    setFailure(null);
  };

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const { userGroupIds } = await surface.api.setAudience(gateway.source, gateway.id, audienceBody(mode, selected));
      setSaved(userGroupIds);
      setDone(true);
      onSaved(userGroupIds);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="gw-section-audience" className="scroll-mt-4 rounded-2xl border border-card-border bg-card-bg p-4 sm:p-5">
      <header className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--leaf-bg)] text-primary">
          <UsersRound size={18} aria-hidden />
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
          setDone(false);
          setFailure(null);
        }}
        options={[
          { value: "everyone", label: t("common", A.everyone), description: t("common", A.everyoneHint), icon: Globe2 },
          { value: "groups", label: t("common", A.groups), description: t("common", A.groupsHint), icon: UsersRound },
        ]}
      />

      {mode === "groups" && (
        <div className="mt-4 rounded-xl border border-card-border bg-[var(--bg-inner)] p-3">
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
                    onChange={(on) => toggle(g.id, on)}
                    label={g.name}
                    hint={t("common", A.members, { count: g.userCount })}
                  />
                </li>
              ))}
            </ul>
          )}
          {error && groups !== null && groups.length > 0 && <p className="mt-2 text-xs font-bold text-error">{t("common", error)}</p>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
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
        <Button variant="primary" size="sm" disabled={!dirty || saving || Boolean(error)} loading={saving} onClick={() => void save()}>
          {t("common", A.save)}
        </Button>
      </div>
    </section>
  );
}
