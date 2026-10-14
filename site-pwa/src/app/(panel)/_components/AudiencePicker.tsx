"use client";

import { Globe2, Lock, UsersRound } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { audienceRows, pickAudience, type AudienceRow } from "../_lib/audience";
import type { AudienceGroups } from "../_hooks/useAudienceGroups";
import { Badge, Checkbox, RadioCards } from "./kit";
import { Skeleton } from "./kit/Skeleton";

const A = FrontendI18nKeys.common.audience;

/** What an empty value means in a single picker's radio group. */
const EVERYONE = "";

export type AudiencePickerProps = {
  /** From `useAudienceGroups`: only what this caller may pick. */
  groups: AudienceGroups;
  /** The chosen group ids; `[]` is "every user". */
  value: string[];
  onChange: (value: string[]) => void;
  /** Any number of groups (a gateway, a product) or one (a discount, a wheel, a lottery). */
  multiple?: boolean;
  /** Offer "every user"; off where a group is required (a lottery). */
  everyone?: boolean;
};

/**
 * Who a feature is for (GR-1-x, ADR-0143) — one picker for discounts,
 * gateways, products, lotteries, the wheel and campaigns. "Every user" is a
 * fixed choice, never a group; then the groups the server lets this caller
 * pick, with how many they reach and whether they give access. A group the
 * record already has but the caller may not pick stays shown and removable.
 */
export function AudiencePicker({ groups, value, onChange, multiple = false, everyone = true }: AudiencePickerProps) {
  const { t } = useLocale();
  if (groups === "failed") {
    return (
      <p role="alert" className="text-xs font-bold text-error">
        {t("common", A.failed)}
      </p>
    );
  }
  if (groups === null) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    );
  }
  const rows = audienceRows(groups, value, { everyone });
  const label = (row: AudienceRow) => (row.kind === "everyone" ? t("common", A.everyone) : row.kind === "group" ? row.group.name : t("common", A.kept));
  const hint = (row: AudienceRow) =>
    row.kind === "everyone" ? (
      t("common", A.everyoneHint)
    ) : row.kind === "kept" ? (
      t("common", A.keptHint)
    ) : (
      <span className="inline-flex flex-wrap items-center gap-2">
        {t("common", A.members, { count: row.group.userCount })}
        {row.group.givesKeys && <Badge tone="info">{t("common", A.givesAccess)}</Badge>}
      </span>
    );
  const idOf = (row: AudienceRow) => (row.kind === "everyone" ? null : row.kind === "group" ? row.group.id : row.id);

  return (
    <div className="space-y-2">
      {multiple ? (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label={t("common", A.label)}>
          {rows.map((row) => (
            <li key={idOf(row) ?? EVERYONE} className="rounded-xl border border-card-border bg-bg-inner p-3">
              <Checkbox
                checked={row.kind === "kept" || row.selected}
                // "Every user" is the empty set: it is chosen by clearing the groups, never unchosen on its own.
                disabled={row.kind === "everyone" && row.selected}
                onChange={(on) => onChange(pickAudience(value, idOf(row), { multiple: true, on }))}
                label={label(row)}
                hint={hint(row)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <RadioCards
          ariaLabel={t("common", A.label)}
          value={value[0] ?? EVERYONE}
          onChange={(id) => onChange(pickAudience(value, id === EVERYONE ? null : id, { multiple: false, on: true }))}
          options={rows.map((row) => ({
            value: idOf(row) ?? EVERYONE,
            label: label(row),
            description: hint(row),
            icon: row.kind === "everyone" ? Globe2 : row.kind === "kept" ? Lock : UsersRound,
          }))}
        />
      )}
      {groups.length === 0 && <p className="text-xs leading-6 text-text-secondary">{t("common", A.none)}</p>}
    </div>
  );
}
