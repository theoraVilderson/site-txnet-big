"use client";

import { Copy, Home, RotateCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_HOME } from "@/lib/routes";
import { Button, IconButton } from "./_components/kit/Button";
import { Card } from "./_components/kit/Card";
import { notify } from "./_components/kit/notify";
import { copyText } from "./_lib/clipboard";

const E = FrontendI18nKeys.common.shell.error;

/**
 * A page that crashed while rendering (UX-1-i, `contract.ux.md` N9). The shell
 * around it still works, so this is a card in the page's place: try again
 * (Next's `reset`), back to the dashboard, and the digest — the server's id
 * for this failure in its logs — with a copy button, so support can find it.
 * The error's own message is never shown: it is for developers, and in
 * production Next has already replaced it.
 */
export default function PanelError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useLocale();

  useEffect(() => {
    console.error(error);
  }, [error]);

  const copy = async () => {
    if (error.digest && (await copyText(error.digest))) notify.success(t("common", E.copied));
  };

  return (
    <div className="mx-auto flex w-full max-w-xl p-4 md:p-8">
      <Card role="alert" className="flex w-full flex-col items-center gap-4 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-error-bg text-error">
          <TriangleAlert size={28} aria-hidden />
        </span>
        <div>
          <h1 className="text-lg font-bold text-text-primary">{t("common", E.title)}</h1>
          <p className="mt-1 text-sm leading-6 text-text-secondary">{t("common", E.body)}</p>
        </div>
        {error.digest && (
          <div className="flex w-full items-center justify-between gap-2 rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-start">
            <span className="flex min-w-0 flex-col">
              <span className="text-[11px] text-text-secondary">{t("common", E.digest)}</span>
              <code dir="ltr" className="truncate font-mono text-xs text-text-primary">
                {error.digest}
              </code>
            </span>
            <IconButton aria-label={t("common", E.copy)} icon={<Copy size={14} aria-hidden />} variant="quiet" size="sm" onClick={() => void copy()} />
          </div>
        )}
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-center">
          <Link
            href={PANEL_HOME}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-card-border bg-card-bg px-4 text-sm font-bold text-text-primary hover:border-primary hover:bg-leaf-bg"
          >
            <Home size={16} aria-hidden />
            {t("common", E.home)}
          </Link>
          <Button icon={<RotateCw size={16} aria-hidden />} onClick={reset}>
            {t("common", E.retry)}
          </Button>
        </div>
      </Card>
    </div>
  );
}
