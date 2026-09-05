"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { authApi } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { AUTH_LOGIN } from "@/lib/routes";

export function LogoutButton() {
  const { t } = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    setPending(true);
    try {
      await authApi.logout();
    } catch {
      // The session may already be gone server-side (expired, revoked
      // elsewhere). Either way this device is signed out and belongs on the
      // login screen, so a failed call must not strand the user here.
    } finally {
      // replace, not push: the panel must not be reachable with Back.
      router.replace(AUTH_LOGIN);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className="flex items-center gap-2 rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-secondary transition-colors duration-300 hover:border-error hover:text-error disabled:opacity-60"
    >
      <LogOut size={16} className="rtl:-scale-x-100" />
      <span>{pending ? t("common", "loggingOut") : t("common", "logout")}</span>
    </button>
  );
}
