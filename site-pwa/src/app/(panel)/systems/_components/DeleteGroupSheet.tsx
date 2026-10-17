"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelGroup } from "@/lib/billing-api";
import { Sheet } from "../../catalog/_components/catalog-ui";
import { groupDeleteBlock } from "../_lib/panel-lifecycle";
import { SYSTEMS_KEYS } from "../_lib/systems";
import { Notice, useSystemsError } from "./parts";
import { Button } from "../../_components/kit";

const K = SYSTEMS_KEYS.groups;

/**
 * Delete a group (F-027-ca, billing rule 24a). The button is offered only on
 * an empty group no variant names; otherwise the sheet says what to do first.
 */
export function DeleteGroupSheet({ group, onClose, onDone }: { group: PanelGroup; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const block = groupDeleteBlock(group);

  const remove = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await billingApi.deletePanelGroup(group.id);
      await onDone();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={t("common", SYSTEMS_KEYS.groupsRemove.title, { group: group.name })}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="quiet" size="sm" onClick={onClose}>
            {t("common", K.cancel)}
          </Button>
          {!block && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              icon={<Trash2 size={14} aria-hidden />}
              className="text-error hover:text-error hover:bg-error-bg"
            >
              {t("common", SYSTEMS_KEYS.groupsRemove.submit)}
            </Button>
          )}
        </div>
      }
    >
      {block ? (
        <Notice tone="bad">{t("common", block.key, { n: String(block.n) })}</Notice>
      ) : (
        <p className="text-sm leading-6 text-text-secondary">{t("common", SYSTEMS_KEYS.groupsRemove.hint)}</p>
      )}
      {failure && <Notice tone="bad">{failure}</Notice>}
    </Sheet>
  );
}
