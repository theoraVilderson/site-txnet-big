"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UserRoundCog } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { authApi } from "@/lib/auth-api";
import { numberLocale } from "../_lib/digits";
import { Button, notify } from "./kit";
import { TONE_PILL } from "./kit/StatusPill";
import { cn } from "./kit/cn";
import { useImpersonation } from "../_hooks/useImpersonation";

const K = FrontendI18nKeys.common.impersonation;

/** `ms` as `mm:ss` in Latin digits like every number (`digits.ts`), never below zero. */
export function impersonationTimeLeft(ms: number, lang: string): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const two = new Intl.NumberFormat(numberLocale(lang), { minimumIntegerDigits: 2, useGrouping: false });
  return `${two.format(Math.floor(total / 60))}:${two.format(total % 60)}`;
}

/**
 * "You are signed in as {name}" on every page while an admin is (AC-1-i,
 * `panel-web/contract.reseller-users.md`): the 30 minutes counting down and an
 * end that goes back to the page it was started from. At zero it ends by
 * itself. A reload ends it too — the token is in this tab's memory only — so
 * the page's unload tells the server rather than leave its session to expire.
 */
export function ImpersonationBanner() {
  const current = useImpersonation();
  const router = useRouter();
  const { t, lang } = useLocale();
  const [now, setNow] = useState(() => Date.now());
  const ending = useRef(false);

  const end = useCallback(
    async (expired: boolean) => {
      if (!current || ending.current) return;
      ending.current = true;
      const back = current.returnTo;
      await authApi.endImpersonation();
      notify.info(t("common", expired ? K.expired : K.ended));
      router.push(back);
    },
    [current, router, t],
  );

  useEffect(() => {
    if (!current) return;
    ending.current = false;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const unload = () => authApi.endImpersonationOnUnload();
    window.addEventListener("pagehide", unload);
    return () => {
      clearInterval(tick);
      window.removeEventListener("pagehide", unload);
    };
  }, [current]);

  useEffect(() => {
    if (current && now >= current.endsAt) void end(true);
  }, [now, current, end]);

  if (!current) return null;
  return (
    <div
      role="status"
      className={cn("mx-4 mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border px-4 py-2.5 text-sm", TONE_PILL.warning)}
    >
      <UserRoundCog size={18} aria-hidden className="shrink-0" />
      <p className="min-w-0 flex-1 font-bold text-text-primary">
        {t("common", K.banner, { name: current.name })}
        <span className="ms-2 font-normal text-text-secondary">{t("common", K.reloadEnds)}</span>
      </p>
      <span className="tabular-nums" aria-live="off">
        {t("common", K.timeLeft, { time: impersonationTimeLeft(current.endsAt - now, lang) })}
      </span>
      <Button variant="secondary" size="sm" onClick={() => void end(false)}>
        {t("common", K.end)}
      </Button>
    </div>
  );
}
