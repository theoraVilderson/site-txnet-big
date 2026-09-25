"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { userGroupsApi, type UserGroup } from "@/lib/auth-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import {
  USER_GROUP_KEYS as K,
  canNameResellers,
  createGroupBody,
  emptyGroupForm,
  updateGroupBody,
  validateGroupForm,
  type Errors,
  type GroupForm,
} from "../_lib/user-groups";
import { Alert, Field, Sheet, input, primaryButton, useMessage } from "./user-groups-ui";

/**
 * Create a group, or rename one (F-114-m). "Every reseller" is the platform
 * owner's only and is never sent for a reseller; an edit sends only what
 * changed (`updateGroupBody`).
 */
export function GroupSheet({ group, onClose, onSaved }: { group: UserGroup | null; onClose: () => void; onSaved: (g: UserGroup | null) => void }) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const message = useMessage();
  const was: GroupForm = group ? { name: group.name, allTenants: group.allTenants } : emptyGroupForm;
  const [form, setForm] = useState<GroupForm>(was);
  const [errors, setErrors] = useState<Errors<GroupForm>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const found = validateGroupForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    if (group) {
      const body = updateGroupBody(form, was, me);
      if (!body) return onSaved(null);
      setBusy(true);
      try {
        onSaved(await userGroupsApi.update(group.id, body));
      } catch (e) {
        setFailure(message(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      onSaved(await userGroupsApi.create(createGroupBody(form, me)));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t("common", group ? K.form.editTitle : K.form.createTitle)}
      onClose={onClose}
      footer={
        <button type="button" className={primaryButton} disabled={busy} onClick={submit}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("common", K.form.save)}
        </button>
      }
    >
      <Field label={t("common", K.form.name)} hint={t("common", K.form.nameHint)} error={errors.name}>
        <input className={input} value={form.name} maxLength={80} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </Field>
      {canNameResellers(me) && (
        <label className="flex items-start gap-2 text-xs text-text-secondary">
          <input type="checkbox" className="mt-0.5" checked={form.allTenants} onChange={(e) => setForm((f) => ({ ...f, allTenants: e.target.checked }))} />
          <span className="flex flex-col gap-0.5">
            <span className="font-bold text-text-primary">{t("common", K.form.allTenants)}</span>
            <span>{t("common", K.form.allTenantsHint)}</span>
          </span>
        </label>
      )}
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}
