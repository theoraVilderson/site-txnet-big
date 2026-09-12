/**
 * The label beside an icon-only rail entry; decorative, because the entry it
 * belongs to also carries the same words as `sr-only` text.
 *
 * Its own file rather than `PanelSidebar`'s, so the sidebar and the controls it
 * renders can both use it without importing each other (`LogoutButton` is a
 * child of the rail and needs the same tooltip its siblings get).
 */
export function CollapsedTooltip({
  collapsed,
  label,
}: {
  collapsed: boolean;
  label: string;
}) {
  if (!collapsed) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute start-full top-1/2 z-50 ms-3 hidden -translate-y-1/2 whitespace-nowrap rounded-lg border border-card-border bg-card-bg px-2 py-1 text-xs text-text-primary opacity-0 shadow-lg backdrop-blur-xl transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 lg:block"
    >
      {label}
    </span>
  );
}
