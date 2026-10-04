"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { CircleHelp } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { guideReadApi } from "@/lib/guide-api";
import { sectionOfPath } from "../../_lib/guide-help";
import { GuideList, GuideSheet, useSlotGuides } from "./GuideList";

const H = FrontendI18nKeys.common.guideHelp;

/**
 * The top bar's help (F-414-e): the guides placed on this page's section
 * (`route:<section>`, `guide/data-model.md` "Slots"), in a sheet. Nothing is
 * read until it opens — a page view costs no guide request — and the section
 * is the one the path is in when it opens. 40px, before the switcher
 * (`contract.shell.md` rule 5; the phone row had room for one more control).
 */
export function HelpButton() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("common", H.open)}
        title={t("common", H.open)}
        aria-haspopup="dialog"
        className="rounded-xl border border-card-border bg-leaf-bg p-2 text-text-primary transition-colors hover:border-primary"
      >
        <CircleHelp size={20} aria-hidden />
      </button>
      {open && <HelpSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function HelpSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const section = sectionOfPath(usePathname() ?? "/");
  const slot = useSlotGuides(`route:${section}`, () => guideReadApi.forSlot("route", section));
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <GuideSheet title={t("common", H.title)} onClose={onClose}>
      <GuideList {...slot} empty={t("common", H.empty)} open={openKey} onOpen={setOpenKey} />
    </GuideSheet>
  );
}
