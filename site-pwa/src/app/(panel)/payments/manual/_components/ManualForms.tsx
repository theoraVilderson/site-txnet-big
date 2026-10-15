"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { Button, Checkbox, Field, Input, Textarea } from "../../../_components/kit";
import { MANUAL_KEYS as K, validateAuthority, validateConfirm, validateReject, type ConfirmInput } from "../_lib/manual-confirm";

interface FormProps<T> {
  busy: boolean;
  onSubmit: (value: T) => void;
  onCancel: () => void;
}

/** The frame every hand action shares: a title, the hint that says when it is right, the fields, submit and cancel. */
function ActionForm(props: {
  title: ReactNode;
  hint: string;
  submit: string;
  cancel: string;
  busy: boolean;
  danger?: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const danger = props.danger ? "text-error hover:text-error hover:bg-error-bg" : undefined;
  return (
    <form
      onSubmit={props.onSubmit}
      className={`flex flex-col gap-3 rounded-2xl border bg-bg-inner p-4 ${props.danger ? "border-error-border" : "border-card-border"}`}
    >
      <p className={`flex items-center gap-2 text-sm font-bold ${props.danger ? "text-error" : "text-text-primary"}`}>{props.title}</p>
      <p className="text-xs leading-5 text-text-secondary">{props.hint}</p>
      {props.children}
      <div className="flex flex-wrap gap-2">
        <Button variant={props.danger ? undefined : "primary"} size="sm" type="submit" disabled={props.busy} className={danger}>
          {props.submit}
        </Button>
        <Button variant="quiet" size="sm" onClick={props.onCancel}>
          {props.cancel}
        </Button>
      </div>
    </form>
  );
}

/** A lost authority, typed from the gateway's own panel (F-093-o). */
export function AuthorityForm({ busy, onSubmit, onCancel }: FormProps<string>) {
  const { t } = useLocale();
  const [authority, setAuthority] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const checked = validateAuthority(authority);
    setError(checked.ok ? null : checked.error);
    if (checked.ok) onSubmit(checked.authority);
  };
  const F = K.authorityForm;
  return (
    <ActionForm title={t("common", F.title)} hint={t("common", F.hint)} submit={t("common", F.submit)} cancel={t("common", F.cancel)} busy={busy} onSubmit={submit} onCancel={onCancel}>
      <Field label={t("common", F.label)} error={error ? t("common", error) : undefined}>
        <Input dir="ltr" value={authority} maxLength={64} onChange={(e) => setAuthority(e.target.value)} className="font-mono" />
      </Field>
    </ActionForm>
  );
}

/** Confirm by hand; a transfer's reference starts as the one the payer sent (F-803-k). */
export function ConfirmForm({ busy, onSubmit, onCancel, initialReference }: FormProps<ConfirmInput> & { initialReference: string }) {
  const { t } = useLocale();
  const [form, setForm] = useState<ConfirmInput>({ referenceId: initialReference, reason: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof ConfirmInput, string>>>({});
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const checked = validateConfirm(form);
    setErrors(checked.ok ? {} : checked.errors);
    if (checked.ok) onSubmit(checked.body);
  };
  const F = K.form;
  return (
    <ActionForm title={t("common", F.title)} hint={t("common", F.hint)} submit={t("common", F.submit)} cancel={t("common", F.cancel)} busy={busy} onSubmit={submit} onCancel={onCancel}>
      <Field label={t("common", F.referenceId)} error={errors.referenceId ? t("common", errors.referenceId) : undefined}>
        <Input dir="ltr" value={form.referenceId} maxLength={64} onChange={(e) => setForm((f) => ({ ...f, referenceId: e.target.value }))} />
      </Field>
      <Field label={t("common", F.reason)} error={errors.reason ? t("common", errors.reason) : undefined}>
        <Textarea value={form.reason} maxLength={500} rows={3} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
      </Field>
    </ActionForm>
  );
}

export type RejectInput = { reason: string; resubmit: boolean };

/**
 * Reject by hand (F-093-p). A transfer whose proof billing may still send back
 * (`canReturn`) offers that instead of closing — once (F-805-a).
 */
export function RejectForm({ busy, onSubmit, onCancel, mayReturn }: FormProps<RejectInput> & { mayReturn: boolean }) {
  const { t } = useLocale();
  const [reason, setReason] = useState("");
  const [resubmit, setResubmit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const checked = validateReject(reason);
    setError(checked.ok ? null : checked.error);
    if (checked.ok) onSubmit({ reason: checked.reason, resubmit: mayReturn && resubmit });
  };
  const F = K.rejectForm;
  const returning = mayReturn && resubmit;
  return (
    <ActionForm
      danger={!returning}
      title={
        <>
          <TriangleAlert size={14} aria-hidden />
          {t("common", F.title)}
        </>
      }
      hint={t("common", returning ? F.resubmitHint : F.hint)}
      submit={t("common", returning ? F.submitReturn : F.submit)}
      cancel={t("common", F.cancel)}
      busy={busy}
      onSubmit={submit}
      onCancel={onCancel}
    >
      {mayReturn && <Checkbox checked={resubmit} onChange={setResubmit} label={t("common", F.resubmit)} />}
      <Field label={t("common", F.reason)} error={error ? t("common", error) : undefined}>
        <Textarea value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ActionForm>
  );
}
