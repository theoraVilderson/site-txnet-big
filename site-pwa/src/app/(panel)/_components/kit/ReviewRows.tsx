import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "./Button";

/** One label and its value on a wizard's review step. */
export type ReviewRow = [string, ReactNode];

interface ReviewRowsProps {
  icon: LucideIcon;
  title: ReactNode;
  editLabel: string;
  onEdit: () => void;
  rows: readonly ReviewRow[];
}

/**
 * A wizard's review of one step (UX-1, K5): the step's title with a way back
 * to it, then its choices as label–value rows. The caller supplies the frame,
 * so a review may animate its sections or not.
 */
export function ReviewRows({ icon: Icon, title, editLabel, onEdit, rows }: ReviewRowsProps) {
  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-bold text-text-primary">
          <Icon size={14} className="text-primary" aria-hidden />
          {title}
        </h3>
        <Button variant="quiet" size="sm" onClick={onEdit} className="text-primary hover:text-primary">
          {editLabel}
        </Button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 text-xs">
            <dt className="shrink-0 text-text-secondary">{k}</dt>
            <dd className="min-w-0 text-end font-bold text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
