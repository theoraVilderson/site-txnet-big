"use client";

import { useMemo } from "react";
import { zoneChoices } from "@/lib/time-zone";
import { useFieldControl } from "./kit/field-context";

/** The kit Input's box (K4), for a zone list inside a kit `Field`. */
const FIELD_CONTROL =
  "h-11 w-full rounded-xl border border-card-border bg-bg-inner px-3 text-sm text-[var(--text-input)] transition-colors hover:border-primary focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A native select over every IANA zone this browser knows (TZ-1-e) — a few
 * hundred options, so the browser's own list with type-to-find, like the
 * other zone fields. With `nullLabel`, a first option stands for null: "follow
 * whatever my zone is", which the caller names. A saved zone this browser does
 * not list is still offered, so opening the picker never changes what is stored.
 */
export function ZoneSelect({
  id,
  value,
  onChange,
  nullLabel,
  disabled,
  className,
}: {
  id?: string;
  value: string | null;
  onChange: (zone: string | null) => void;
  nullLabel?: string;
  disabled?: boolean;
  /** Absent inside a kit `Field`: it then takes the kit's box and the Field's id and description. */
  className?: string;
}) {
  const zones = useMemo(() => zoneChoices(value), [value]);
  const field = useFieldControl();
  return (
    <select
      id={id ?? field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      dir="ltr"
      className={className ?? FIELD_CONTROL}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    >
      {nullLabel !== undefined && <option value="">{nullLabel}</option>}
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </select>
  );
}
