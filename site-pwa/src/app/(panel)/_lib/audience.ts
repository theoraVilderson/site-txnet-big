import type { AudienceGroup } from "@/lib/auth-api";

/**
 * One row of the audience picker (GR-1-x, ADR-0143). "Every user" is a fixed
 * choice, not a group: it is the empty set every feature already stores. A
 * `kept` row is a group the record has that this caller may not pick — shown,
 * so a save never drops it unseen, and removable, as the server allows.
 */
export type AudienceRow =
  | { kind: "everyone"; selected: boolean }
  | { kind: "group"; group: AudienceGroup; selected: boolean }
  | { kind: "kept"; id: string };

/** The picker's rows: "every user" first unless a group is required, the pickable groups, then the kept ones. */
export function audienceRows(groups: readonly AudienceGroup[], value: readonly string[], opts: { everyone: boolean }): AudienceRow[] {
  const listed = new Set(groups.map((g) => g.id));
  return [
    ...(opts.everyone ? [{ kind: "everyone" as const, selected: value.length === 0 }] : []),
    ...groups.map((group) => ({ kind: "group" as const, group, selected: value.includes(group.id) })),
    ...value.filter((id) => !listed.has(id)).map((id) => ({ kind: "kept" as const, id })),
  ];
}

/** The value after a click: `null` is "every user"; a single picker holds one group, a multiple one any. */
export function pickAudience(value: readonly string[], id: string | null, opts: { multiple: boolean; on: boolean }): string[] {
  if (id === null) return [];
  if (!opts.multiple) return opts.on ? [id] : value.filter((x) => x !== id);
  if (!opts.on) return value.filter((x) => x !== id);
  return value.includes(id) ? [...value] : [...value, id];
}

/** Whether a saved set and a picked one differ, as sets. */
export function audienceChanged(saved: readonly string[], next: readonly string[]): boolean {
  return next.length !== saved.length || next.some((id) => !saved.includes(id));
}
