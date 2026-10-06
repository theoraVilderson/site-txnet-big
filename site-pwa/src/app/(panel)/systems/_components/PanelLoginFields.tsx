"use client";

import { useLocale } from "@/context/LocaleContext";
import { Field } from "../../catalog/_components/catalog-ui";
import type { NewLoginErrors } from "../_lib/panel-lifecycle";
import { loginKindOf, type LoginParts } from "../_lib/register-wizard";
import { SYSTEMS_KEYS as K } from "../_lib/systems";
import { Input } from "../../_components/kit";

/**
 * A registered panel's new login, asked as the register wizard asks it: a
 * username and a password, or the API key alone for a family that logs in
 * with one. `checkNewLogin` is its rule; the edit form and the resubmit sheet
 * both render this, so neither asks for the login as one opaque string.
 */
export function PanelLoginFields({
  driverType,
  parts,
  errors,
  onChange,
}: {
  driverType: string;
  parts: LoginParts;
  errors: NewLoginErrors;
  onChange: (field: keyof LoginParts, value: string) => void;
}) {
  const { t } = useLocale();
  const error = (field: keyof NewLoginErrors) => errors[field] || undefined;
  const secret = (field: "password" | "apiKey") => (
    <Input
      dir="ltr"
      type="password"
      autoComplete="new-password"
      value={parts[field]}
      maxLength={4096}
      onChange={(e) => onChange(field, e.target.value)}
      className="font-mono"
    />
  );

  if (loginKindOf(driverType) === "apiKey") {
    return (
      <Field label={t("common", K.register.wizard.login.apiKey)} error={error("apiKey") ?? error("credentials")}>
        {secret("apiKey")}
      </Field>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t("common", K.register.wizard.login.username)} error={error("username")}>
        <Input
          dir="ltr"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={parts.username}
          onChange={(e) => onChange("username", e.target.value)}
          className="font-mono"
        />
      </Field>
      <Field label={t("common", K.register.wizard.login.password)} error={error("password") ?? error("credentials")}>
        {secret("password")}
      </Field>
    </div>
  );
}
