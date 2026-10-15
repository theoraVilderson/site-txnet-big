"use client";

import { useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { GripVertical, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { MAX_DESTINATIONS, type AdminGateway, type ManualDestination } from "@/lib/billing-api";
import { Button, Dialog, IconButton, Toggle, useConfirm } from "../../../_components/kit";
import { Skeleton } from "../../../_components/kit/Skeleton";
import { transferKind } from "../../../_components/transfer/transfer-kinds";
import { useDestinations, type DestinationsState } from "../../_hooks/useDestinations";
import { useGatewayMessage, type GatewaySurface } from "../../_lib/surface";
import { DestinationEditor } from "./DestinationEditor";

const M = FrontendI18nKeys.common.gateways.manual;

interface DestinationsDialogProps {
  surface: GatewaySurface;
  gateway: AdminGateway;
  /** Opened from the wizard's done screen: straight to a new one. */
  startWithNew?: boolean;
  onClose: () => void;
  /** A write changed the counts the page's row shows. */
  onChanged: () => void;
}

interface RowProps {
  destination: ManualDestination;
  summary: string;
  state: DestinationsState;
  onEdit: () => void;
  onRemove: () => void;
  onFailure: (e: unknown) => void;
}

/** One destination: dragged by its handle only, so the toggle and buttons stay ordinary controls. */
function DestinationRow({ destination: d, summary, state, onEdit, onRemove, onFailure }: RowProps) {
  const { t } = useLocale();
  const drag = useDragControls();
  return (
    <Reorder.Item
      value={d}
      dragListener={false}
      dragControls={drag}
      onDragEnd={() => void state.commitOrder().catch(onFailure)}
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-card-border bg-card-bg p-3"
    >
      <button
        type="button"
        aria-label={t("common", M.reorder)}
        onPointerDown={(e) => drag.start(e)}
        className="cursor-grab touch-none text-text-secondary active:cursor-grabbing"
      >
        <GripVertical size={18} aria-hidden />
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-bold text-text-primary">{d.label}</span>
        <span dir="ltr" className="truncate text-start text-2xs text-text-secondary">
          {summary}
        </span>
      </div>
      <Toggle checked={d.isActive} onChange={(on) => void state.update(d, { isActive: on }).catch(onFailure)} label={t("common", M.shown)} />
      <IconButton size="sm" onClick={onEdit} aria-label={t("common", M.edit)} icon={<Pencil size={14} aria-hidden />} />
      <IconButton size="sm" onClick={onRemove} aria-label={t("common", M.remove)} icon={<Trash2 size={14} aria-hidden />} />
    </Reorder.Item>
  );
}

/**
 * A manual gateway's cards or wallets (F-803-g): the list in the order a payer
 * is offered them, reordered by dragging a handle; each shown or hidden in
 * place; added and edited in the same dialog, with the kind's live preview.
 * The gateway is offered only while one is shown (F-803-c).
 */
export function DestinationsDialog({ surface, gateway, startWithNew = false, onClose, onChanged }: DestinationsDialogProps) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const errorMessage = useGatewayMessage(surface);
  const state = useDestinations(surface.api, gateway, onChanged);
  const kind = transferKind(gateway.manual?.kind ?? "");
  const [editing, setEditing] = useState<ManualDestination | "new" | null>(startWithNew ? "new" : null);
  const [notice, setNotice] = useState<string | null>(null);
  const full = state.destinations.length >= MAX_DESTINATIONS;
  const onFailure = (e: unknown) => setNotice(errorMessage(e));

  const remove = async (d: ManualDestination) => {
    if (!(await confirm({ title: t("common", M.confirmRemove, { label: d.label }), confirmLabel: t("common", M.remove), tone: "danger" }))) return;
    try {
      const mode = await state.remove(d);
      setNotice(t("common", mode === "deleted" ? M.removed : M.deactivated));
    } catch (e) {
      onFailure(e);
    }
  };

  const list = state.isLoading ? (
    <div className="flex flex-col gap-2" aria-busy="true">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  ) : state.error ? (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="alert" className="text-xs font-bold text-error">
        {errorMessage(state.error)}
      </p>
      <Button size="sm" onClick={state.reload} icon={<RotateCw size={12} aria-hidden />}>
        {t("common", M.retry)}
      </Button>
    </div>
  ) : state.destinations.length === 0 ? (
    <p className="py-6 text-center text-xs text-text-secondary">{t("common", M.noDestinations)}</p>
  ) : (
    <Reorder.Group axis="y" values={state.destinations} onReorder={state.reorder} className="flex flex-col gap-2">
      {state.destinations.map((d) => (
        <DestinationRow
          key={d.id}
          destination={d}
          summary={kind.summary(d.fields)}
          state={state}
          onEdit={() => setEditing(d)}
          onRemove={() => void remove(d)}
          onFailure={onFailure}
        />
      ))}
    </Reorder.Group>
  );

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={t("common", editing ? (editing === "new" ? M.addDestination : M.editDestination) : M.destinationsOf, { name: gateway.displayName })}
      description={editing ? undefined : t("common", M.destinationsHint)}
      footer={
        editing ? undefined : (
          <Button variant="primary" disabled={full || state.isLoading} onClick={() => setEditing("new")} icon={<Plus size={16} aria-hidden />}>
            {t("common", M.addDestination)}
          </Button>
        )
      }
    >
      {editing ? (
        <DestinationEditor
          surface={surface}
          gateway={gateway}
          destination={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice(null);
            state.reload();
          }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {notice && (
            <p role="status" className="rounded-xl border border-card-border bg-[var(--bg-inner)] p-3 text-xs text-text-primary">
              {notice}
            </p>
          )}
          {list}
          {full && <p className="text-2xs text-text-secondary">{t("common", M.full, { max: String(MAX_DESTINATIONS) })}</p>}
        </div>
      )}
    </Dialog>
  );
}
