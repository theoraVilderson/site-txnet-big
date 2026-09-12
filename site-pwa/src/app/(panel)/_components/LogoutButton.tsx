"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { CollapsedTooltip } from "./CollapsedTooltip";
import { authApi } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { usePanelSession } from "../_context/PanelSessionContext";
import { AUTH_LOGIN } from "@/lib/routes";

import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The `common` namespace as generated constants (F-083, C-06). */
const C = FrontendI18nKeys.common;

export function LogoutButton({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useLocale();
  const router = useRouter();
  const { reload } = usePanelSession();
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    setPending(true);
    try {
      const result = await authApi.logout();
      // ADR-0035: this place may still hold another account the user proved,
      // in which case the server signed us into it rather than into nothing.
      // Staying is the whole point — sending them to the login screen would
      // throw away the session it just minted.
      if (result.switchedTo) {
        await reload();
        setPending(false);
        return;
      }
    } catch {
      // The session may already be gone server-side (expired, revoked
      // elsewhere). Either way this device is signed out and belongs on the
      // login screen, so a failed call must not strand the user here.
    }
    // replace, not push: the panel must not be reachable with Back.
    router.replace(AUTH_LOGIN);
  };

  const label = t("common", pending ? C.loggingOut : C.logout);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      // Shaped like a nav entry, because that is what it is now: same padding,
      // same icon size, same `lg:sr-only` label and tooltip when the rail is
      // collapsed. It lives in the sidebar footer at every width and is not a
      // top-bar control at all — the bar was over budget at 360px and at 700px,
      // and this was its widest item (`contract.shell.md` rule 5).
      className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-text-secondary transition-colors duration-200 hover:bg-error-bg hover:text-error disabled:opacity-60 ${
        collapsed ? "lg:justify-center" : ""
      }`}
    >
      <LogOut size={22} className="shrink-0 rtl:-scale-x-100" aria-hidden />
      <span className={`flex-1 truncate text-start font-medium ${collapsed ? "lg:sr-only" : ""}`}>
        {label}
      </span>
      <CollapsedTooltip collapsed={collapsed} label={label} />
    </button>
  );
}
