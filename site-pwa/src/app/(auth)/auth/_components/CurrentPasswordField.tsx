"use client";

import { PasswordField } from "@auth/auth/_components/PasswordField";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";

/** The sign-in password: the browser's saved one, with the screen's own labels (login, Mini App). */
export function CurrentPasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useAuthUI();
  return (
    <PasswordField
      id="password"
      label={t.password}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      showLabel={t.showPassword}
      hideLabel={t.hidePassword}
      autoComplete="current-password"
    />
  );
}
