"use client";

import { useMemo } from "react";
import { zoneChoices } from "@/lib/time-zone";

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
  className: string;
}) {
  const zones = useMemo(() => zoneChoices(value), [value]);
  return (
    <select
      id={id}
      dir="ltr"
      className={className}
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
