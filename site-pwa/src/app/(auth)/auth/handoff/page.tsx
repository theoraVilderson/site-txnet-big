"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authApi } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import { AUTH_LOGIN, PANEL_HOME } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const C = FrontendI18nKeys.common;

/**
 * A reseller's own domain, arriving from the platform panel's "my reseller
 * panel" (F-061-f). The fragment holds a single-use code; spending it opens a
 * session of the same account here, and the panel takes over.
 *
 * The fragment is dropped from the address bar before the code is spent, so it
 * is neither in history nor reusable from Back. Any failure — expired, spent,
 * another domain's — ends at the login screen's link: signing in by hand is
 * always the fallback.
 */
export default function HandoffPage() {
  const { t } = useLocale();
  const { t: auth } = useAuthUI();
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // Once: a second run (strict mode) would find the code already spent.
    if (started.current) return;
    started.current = true;

    const code = window.location.hash.slice(1);
    window.history.replaceState(null, "", window.location.pathname);
    if (!code) {
      setFailed(true);
      return;
    }
    authApi
      .redeemHandoff(code)
      .then(() => router.replace(PANEL_HOME))
      .catch(() => setFailed(true));
  }, [router]);

  return (
    <div className="flex w-full flex-col items-center gap-4 p-8 text-center">
      <p className="text-text-primary">
        {t("common", failed ? C.handoffFailed : C.openingResellerPanel)}
      </p>
      {failed && (
        <Link href={AUTH_LOGIN} className="text-primary font-bold hover:underline">
          {auth.login}
        </Link>
      )}
    </div>
  );
}
