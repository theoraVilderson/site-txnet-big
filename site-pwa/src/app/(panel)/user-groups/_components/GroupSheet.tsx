"use client";

import { useState } from "react";
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
import { Alert, Field, Sheet, useMessage } from "./user-groups-ui";
import { Button, Checkbox, Input } from "../../_components/kit";

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
        <Button variant="primary" size="sm" onClick={submit} loading={busy}>
          {t("common", K.form.save)}
        </Button>
      }
    >
      <Field label={t("common", K.form.name)} hint={t("common", K.form.nameHint)} error={errors.name}>
        <Input value={form.name} maxLength={80} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </Field>
      {canNameResellers(me) && (
        <Checkbox
          checked={form.allTenants}
          onChange={(allTenants) => setForm((f) => ({ ...f, allTenants }))}
          label={<span className="font-bold">{t("common", K.form.allTenants)}</span>}
          hint={t("common", K.form.allTenantsHint)}
        />
      )}
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}
