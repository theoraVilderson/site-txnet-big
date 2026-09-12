import type { LucideIcon } from "lucide-react";

export interface BadgeTone {
  icon: LucideIcon;
  /** Already translated. A badge never holds a key. */
  label: string;
  /** Background, text and border in one — the tones live in `_lib/tones.ts`. */
  className: string;
}

export interface BadgeProps extends BadgeTone {
  /** Show only the icon on a narrow bar, where three badges do not fit beside an amount. */
  hideLabelBelowLg?: boolean;
}

/**
 * A status or gateway pill (F-093-d). The label is kept in the DOM when it is
 * visually hidden, because the icon alone says nothing to a screen reader and
 * the colour says nothing to a reader who cannot see it.
 */
export function Badge({ icon: Icon, label, className, hideLabelBelowLg }: BadgeProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${className}`}
      title={label}
    >
      <Icon size={10} aria-hidden />
      <span className={hideLabelBelowLg ? "sr-only lg:not-sr-only" : undefined}>{label}</span>
    </span>
  );
}
