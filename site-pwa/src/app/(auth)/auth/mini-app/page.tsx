"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CurrentPasswordField } from "@auth/auth/_components/CurrentPasswordField";
import { SubmitButton } from "@auth/auth/_components/SubmitButton";
import { AuthCardShell, SuccessShell } from "@auth/auth/_components/AuthCardShell";
import { FormError } from "@auth/auth/_components/FormError";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import { useSubmitError } from "@auth/auth/_hooks/useSubmitError";
import { authApi } from "@/lib/auth-api";
import { miniAppHost } from "@/lib/mini-app";
import { consumeReturnTo } from "@/lib/return-to";
import { AUTH_LOGIN } from "@/lib/routes";

/**
 * The Mini App's own sign-in for an account the messenger alone does not sign
 * in (SA-1-e, ADR-0145 as amended): the messenger's signature is one factor,
 * the password typed here the other. The panel lands here only from
 * `PanelSessionProvider`, when `webapp/session` answered `needsPassword`.
 */
export default function MiniAppPasswordPage() {
  const { t } = useAuthUI();
  const router = useRouter();
  const submitError = useSubmitError();
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    submitError.clear();
    setIsLoading(true);
    try {
      // Outside a messenger there is no signature to stand beside the password.
      const host = await miniAppHost();
      if (!host) return router.replace(AUTH_LOGIN);
      const result = await authApi.webAppSession(host.platform, host.initData, password);
      if (result.state !== "authenticated") return router.replace(AUTH_LOGIN);
      setIsSuccess(true);
      router.replace(consumeReturnTo());
    } catch (error) {
      submitError.capture(error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isSuccess) return <SuccessShell title={t.loginSuccess} subtitle={t.redirecting} />;

  return (
    <AuthCardShell animationKey="mini-app" title={t.miniAppTitle} subtitle={t.miniAppSubtitle}>
      <form onSubmit={handleSubmit} noValidate>
        <FormError message={submitError.error?.message ?? null} reference={submitError.error?.ref} detail={submitError.error?.detail} />
        <CurrentPasswordField value={password} onChange={setPassword} />
        <SubmitButton isLoading={isLoading} disabled={password.length === 0}>
          {isLoading ? t.processing : t.miniAppSubmit}
        </SubmitButton>
      </form>
      <Link href={AUTH_LOGIN} className="mt-4 block text-center text-sm text-text-secondary hover:text-text-primary">
        {t.miniAppOtherWay}
      </Link>
    </AuthCardShell>
  );
}
