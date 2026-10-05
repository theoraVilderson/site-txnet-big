"use client";

import { useState } from "react";
import { Check, Circle, Pencil } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { authApi } from "@/lib/auth-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Button } from "../../_components/kit/Button";
import { Card, CardHeader } from "../../_components/kit/Card";
import { cn } from "../../_components/kit/cn";
import { Field, Input, PasswordInput } from "../../_components/kit/Field";
import { notify } from "../../_components/kit/notify";
import { SaveBar } from "../../_components/kit/SaveBar";
import { Toggle } from "../../_components/kit/Toggle";
import { meetsPasswordRules, PASSWORD_RULES, passwordChecks, passwordStrength } from "../_lib/password";

const P = FrontendI18nKeys.common.settings.profile;

/** Settings > Profile's own cards (UX-1-u, `contract.ux.md` S3–S4): the name, then the password. */
export function ProfileSection() {
  return (
    <>
      <NameCard />
      <PasswordCard />
    </>
  );
}

/**
 * The name, shown with an edit button that turns into a field in place (S3).
 * One field with its own Save and Cancel, so no `SaveBar`: the edit is the
 * form, and Cancel puts the name back. The name shown is `GET auth/me`'s,
 * reloaded after a save — never the one typed.
 */
function NameCard() {
  const { t } = useLocale();
  const { me, reload } = usePanelSession();
  const toMessage = useApiErrorMessage();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    setDraft(null);
    setError(null);
  };

  const save = async (fullName: string) => {
    setPending(true);
    setError(null);
    try {
      await authApi.renameMe(fullName);
      await reload();
      setDraft(null);
      notify.success(t("common", P.name.saved));
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card padding="lg">
      <CardHeader title={t("common", P.title)} subtitle={t("common", P.subtitle)} />
      {draft === null ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-card-border bg-bg-inner px-4 py-3">
          <div className="min-w-0">
            <div className="text-xs text-text-secondary">{t("common", P.name.label)}</div>
            <div className="truncate font-medium text-text-primary">{me?.fullName}</div>
          </div>
          <Button
            variant="quiet"
            size="sm"
            icon={<Pencil size={16} aria-hidden />}
            aria-label={t("common", P.name.edit)}
            onClick={() => setDraft(me?.fullName ?? "")}
          />
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save(draft.trim());
          }}
        >
          <Field id="settings-full-name" label={t("common", P.name.label)} error={error ?? undefined}>
            <Input autoFocus autoComplete="name" maxLength={120} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" disabled={pending} onClick={cancel}>
              {t("common", P.name.cancel)}
            </Button>
            <Button type="submit" variant="primary" loading={pending} disabled={draft.trim().length < 2}>
              {t("common", P.name.save)}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

const EMPTY = { current: "", next: "", repeat: "" };

/**
 * The password changed signed in (S4): current, new with a strength meter,
 * repeat, and "sign out every other place" — ticked by default, because a
 * password is usually changed when someone else may know it. Saved through
 * the `SaveBar` (K11). A wrong current password (400 `wrong_password`) is said
 * under that field; any other refusal under the new one. The fields clear only
 * on success.
 */
function PasswordCard() {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [form, setForm] = useState(EMPTY);
  const [endOthers, setEndOthers] = useState(true);
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({});

  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((errs) => (key === "repeat" ? errs : { ...errs, [key]: undefined }));
  };

  const dirty = form.current !== "" || form.next !== "" || form.repeat !== "";
  const mismatch = form.repeat !== "" && form.repeat !== form.next;
  const valid = form.current !== "" && meetsPasswordRules(form.next) && form.repeat === form.next;

  const [savedMessage, setSavedMessage] = useState<string>(t("common", P.password.saved));

  const save = async () => {
    setErrors({});
    try {
      const { otherSessionsEnded } = await authApi.changePassword(form.current, form.next, endOthers);
      setSavedMessage(
        otherSessionsEnded > 0 ? t("common", P.password.savedEnded, { count: otherSessionsEnded }) : t("common", P.password.saved),
      );
      setForm(EMPTY);
    } catch (e) {
      const message = toMessage(e);
      setErrors(e instanceof ApiError && e.reason === "wrong_password" ? { current: message } : { next: message });
      throw e;
    }
  };

  return (
    <Card padding="lg">
      <CardHeader title={t("common", P.password.title)} subtitle={t("common", P.password.subtitle)} />
      <div className="space-y-4">
        <Field id="settings-password-current" label={t("common", P.password.current)} error={errors.current}>
          <PasswordInput autoComplete="current-password" value={form.current} onChange={set("current")} />
        </Field>
        <Field id="settings-password-new" label={t("common", P.password.new)} error={errors.next}>
          <PasswordInput autoComplete="new-password" maxLength={72} value={form.next} onChange={set("next")} />
        </Field>
        {form.next !== "" && <StrengthMeter password={form.next} />}
        <Field
          id="settings-password-repeat"
          label={t("common", P.password.repeat)}
          error={mismatch ? t("common", P.password.mismatch) : undefined}
        >
          <PasswordInput autoComplete="new-password" maxLength={72} value={form.repeat} onChange={set("repeat")} />
        </Field>
        <Toggle
          checked={endOthers}
          onChange={setEndOthers}
          label={t("common", P.password.endOthers)}
          hint={t("common", P.password.endOthersHint)}
        />
      </div>
      <SaveBar
        dirty={dirty}
        disabled={!valid}
        onSave={save}
        onDiscard={() => {
          setForm(EMPTY);
          setErrors({});
        }}
        savedMessage={savedMessage}
      />
    </Card>
  );
}

const TONE = ["bg-error", "bg-error", "bg-warning", "bg-primary", "bg-primary"] as const;

/** Four bars filled by `passwordStrength`, its word, and each rule held or not. */
function StrengthMeter({ password }: { password: string }) {
  const { t } = useLocale();
  const level = passwordStrength(password);
  const checks = passwordChecks(password);
  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 gap-1" aria-hidden>
          {[1, 2, 3, 4].map((step) => (
            <span key={step} className={cn("h-1.5 flex-1 rounded-full", step <= level ? TONE[level] : "bg-card-border")} />
          ))}
        </div>
        <span className="text-xs font-medium text-text-secondary">
          {t("common", P.password.strength.label)}: {t("common", P.password.strength[level])}
        </span>
      </div>
      <ul className="grid gap-1 text-xs sm:grid-cols-2">
        {PASSWORD_RULES.map((rule) => (
          <li key={rule} className={cn("flex items-center gap-1.5", checks[rule] ? "text-primary" : "text-text-secondary")}>
            {checks[rule] ? <Check size={14} aria-hidden /> : <Circle size={10} aria-hidden />}
            {t("common", P.password.rules[rule])}
          </li>
        ))}
      </ul>
    </div>
  );
}
