"use client";

import { useLocale } from "@/context/LocaleContext";
import { SYSTEMS_KEYS } from "../../../../systems/_lib/systems";
import type { LoginParts } from "../../../../systems/_lib/register-wizard";
import { Field, Input, PasswordInput } from "../../../../_components/kit";

const W = SYSTEMS_KEYS.register.wizard;

type UserPassword = Pick<LoginParts, "username" | "password">;

/** An admin's username and password, as the register form asks them: an old panel's for a run, or a router's (F-1601-c). */
export function UserPasswordFields({
  parts,
  onChange,
  errorOf,
}: {
  parts: UserPassword;
  onChange: (patch: Partial<UserPassword>) => void;
  errorOf: (field: keyof UserPassword) => string | undefined;
}) {
  const { t } = useLocale();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t("common", W.login.username)} error={errorOf("username")}>
        <Input dir="ltr" autoComplete="off" value={parts.username} onChange={(e) => onChange({ username: e.target.value })} />
      </Field>
      <Field label={t("common", W.login.password)} error={errorOf("password")}>
        <PasswordInput dir="ltr" autoComplete="new-password" value={parts.password} onChange={(e) => onChange({ password: e.target.value })} />
      </Field>
    </div>
  );
}
