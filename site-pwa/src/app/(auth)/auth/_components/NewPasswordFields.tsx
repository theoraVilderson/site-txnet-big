"use client";

import { PasswordField } from "@auth/auth/_components/PasswordField";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";

/** True once a confirmation was typed and it differs — an empty one is not yet a mismatch. */
export function passwordsDiffer(password: string, confirmation: string): boolean {
  return confirmation.length > 0 && password !== confirmation;
}

/** A new password and its confirmation, the mismatch shown under the second. */
export function NewPasswordFields({
  password,
  confirmation,
  onPassword,
  onConfirmation,
}: {
  password: string;
  confirmation: string;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
}) {
  const { t } = useAuthUI();
  return (
    <>
      <PasswordField
        id="newPassword"
        label={t.newPassword}
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        showLabel={t.showPassword}
        hideLabel={t.hidePassword}
      />
      <PasswordField
        id="confirmPassword"
        label={t.confirmPassword}
        value={confirmation}
        onChange={(e) => onConfirmation(e.target.value)}
        showLabel={t.showPassword}
        hideLabel={t.hidePassword}
        error={passwordsDiffer(password, confirmation) ? t.passwordMismatch : undefined}
      />
    </>
  );
}
