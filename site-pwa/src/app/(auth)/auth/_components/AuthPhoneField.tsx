"use client";

import { PhoneField } from "@auth/auth/_components/PhoneField";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";

/** `PhoneField` with the auth screens' own labels and language, so a screen passes only the value. */
export function AuthPhoneField({ id, value, onChange }: { id: string; value: string; onChange: (phone: string) => void }) {
  const { t, lang } = useAuthUI();
  return (
    <PhoneField
      id={id}
      label={t.phone}
      value={value}
      onChange={onChange}
      lang={lang}
      countryLabel={t.country}
      searchLabel={t.countrySearch}
      noResultsLabel={t.countryNoResults}
    />
  );
}
