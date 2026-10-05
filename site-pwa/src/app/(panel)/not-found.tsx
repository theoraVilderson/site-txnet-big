"use client";

import { Compass, Home, Search } from "lucide-react";
import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_HOME } from "@/lib/routes";
import { Button } from "./_components/kit/Button";
import { Card } from "./_components/kit/Card";
import { usePanelUiStore } from "./_stores/panel-ui-store";

const N = FrontendI18nKeys.common.shell.notFound;

/**
 * A panel address with no page (UX-1-i, `contract.ux.md` N9), drawn inside the
 * shell so the menu is still there to go somewhere else. `[...missing]` sends
 * every unknown path here. The command palette is the other way out (UX-1-n).
 */
export default function PanelNotFound() {
  const { t } = useLocale();
  const openPalette = usePanelUiStore((s) => s.setPaletteOpen);
  return (
    <div className="mx-auto flex w-full max-w-xl p-4 md:p-8">
      <Card className="flex w-full flex-col items-center gap-4 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-leaf-bg text-primary">
          <Compass size={28} aria-hidden />
        </span>
        <div>
          <p dir="ltr" className="text-4xl font-black text-primary">
            404
          </p>
          <h1 className="mt-2 text-lg font-bold text-text-primary">{t("common", N.title)}</h1>
          <p className="mt-1 text-sm leading-6 text-text-secondary">{t("common", N.body)}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" icon={<Search size={16} aria-hidden />} onClick={() => openPalette(true)}>
          {t("common", N.search)}
        </Button>
        <Link
          href={PANEL_HOME}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-on-accent shadow-md hover:brightness-105"
        >
          <Home size={16} aria-hidden />
          {t("common", N.home)}
        </Link>
        </div>
      </Card>
    </div>
  );
}
