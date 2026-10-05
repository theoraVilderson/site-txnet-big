import { isMenuGroup, type VisibleMenuEntry, type VisibleMenuLink } from "./panel-menu";

/** N5, and auth-api's `ui.pins` schema: at most this many entries are pinned. */
export const MAX_PINS = 8;

/**
 * The links of the visible menu that are pinned, in the order `pins` keeps
 * (UX-1-m, `contract.ux.md` N5). A page inside a group is pinned by its own id.
 * A pinned id the caller cannot see — a permission lost, a page not built — is
 * left out here and kept in `pins`, so it comes back with the permission.
 */
export function pinnedLinks(menu: readonly VisibleMenuEntry[], pins: readonly string[]): VisibleMenuLink[] {
  const links = new Map<string, VisibleMenuLink>();
  for (const e of menu) {
    if (isMenuGroup(e)) e.children.forEach((c) => links.set(c.id, c));
    else links.set(e.id, e);
  }
  return pins.map((id) => links.get(id)).filter((l): l is VisibleMenuLink => l !== undefined);
}

/** `pins` with `id` added at the end, or taken out; a ninth is refused (unchanged). */
export function togglePin(pins: readonly string[], id: string): string[] {
  if (pins.includes(id)) return pins.filter((p) => p !== id);
  return pins.length >= MAX_PINS ? [...pins] : [...pins, id];
}

/**
 * `pins` with the visible ones in `visibleOrder` — a drag, or one step of
 * up/down — and every hidden one kept at its own index, so reordering what the
 * caller sees never loses or moves what they do not.
 */
export function reorderPins(pins: readonly string[], visibleOrder: readonly string[]): string[] {
  const visible = new Set(visibleOrder);
  const next = [...visibleOrder];
  return pins.map((id) => (visible.has(id) ? (next.shift() as string) : id));
}

/** `visible` (the drawn pins' ids) with `id` one step toward the start (`-1`) or the end (`1`). */
export function stepPin(visible: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = visible.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= visible.length) return [...visible];
  const out = [...visible];
  [out[from], out[to]] = [out[to], out[from]];
  return out;
}
