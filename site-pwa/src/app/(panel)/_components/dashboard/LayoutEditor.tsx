"use client";

import { Reorder, useDragControls } from "framer-motion";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { stepPin } from "../../_lib/pins";
import type { DashboardLayout } from "../../_lib/widgets";
import { Button, Card, IconButton, Toggle } from "../kit";

const D = FrontendI18nKeys.common.dashboard;

/**
 * "Edit layout" (UX-1-p, D3): every widget the caller may see, each with a hide
 * toggle, a drag handle and up/down buttons — the keyboard's way to move one.
 * It edits a draft; the dashboard writes `ui.dashboard` on Done.
 */
export function LayoutEditor({
  draft,
  titleOf,
  onChange,
  onReset,
  onDone,
}: {
  draft: DashboardLayout;
  titleOf: (id: string) => string;
  onChange: (next: DashboardLayout) => void;
  onReset: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const setOrder = (order: string[]) => onChange({ ...draft, order });
  const setShown = (id: string, shown: boolean) =>
    onChange({ ...draft, hidden: shown ? draft.hidden.filter((h) => h !== id) : [...draft.hidden, id] });

  return (
    <Card>
      <p className="mb-4 text-sm text-text-secondary">{t("common", D.editHint)}</p>
      <Reorder.Group as="ul" axis="y" values={draft.order} onReorder={setOrder} aria-label={t("common", D.edit)} className="space-y-2">
        {draft.order.map((id, i) => {
          const label = titleOf(id);
          return (
            <EditorRow key={id} id={id} dragLabel={t("common", D.drag)}>
              <Toggle
                className="flex-1"
                checked={!draft.hidden.includes(id)}
                onChange={(shown) => setShown(id, shown)}
                label={t("common", D.show, { label })}
              />
              <IconButton
                size="sm"
                aria-label={t("common", D.moveUp, { label })}
                icon={<ArrowUp size={14} aria-hidden />}
                disabled={i === 0}
                onClick={() => setOrder(stepPin(draft.order, id, -1))}
              />
              <IconButton
                size="sm"
                aria-label={t("common", D.moveDown, { label })}
                icon={<ArrowDown size={14} aria-hidden />}
                disabled={i === draft.order.length - 1}
                onClick={() => setOrder(stepPin(draft.order, id, 1))}
              />
            </EditorRow>
          );
        })}
      </Reorder.Group>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="quiet" onClick={onReset}>
          {t("common", D.reset)}
        </Button>
        <Button onClick={onDone}>{t("common", D.done)}</Button>
      </div>
    </Card>
  );
}

/** A row dragged by its handle only, so the toggle and the buttons still take a press. */
function EditorRow({ id, dragLabel, children }: { id: string; dragLabel: string; children: React.ReactNode }) {
  const controls = useDragControls();
  return (
    <Reorder.Item as="li" value={id} dragListener={false} dragControls={controls} className="flex list-none items-center gap-2">
      <span
        aria-hidden
        title={dragLabel}
        onPointerDown={(e) => controls.start(e)}
        className="flex h-10 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-text-secondary active:cursor-grabbing"
      >
        <GripVertical size={16} />
      </span>
      {children}
    </Reorder.Item>
  );
}
