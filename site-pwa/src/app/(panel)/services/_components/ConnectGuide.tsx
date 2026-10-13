"use client";

import { useState } from "react";
import { BookOpen } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { guideReadApi } from "@/lib/guide-api";
import { Sheet } from "../../_components/kit";
import { GuideList, useSlotGuides } from "../../_components/guide/GuideList";
import { osFromUserAgent, type GuideOs } from "../../_lib/guide-help";
import { GUIDE_OSES } from "../../guides/_lib/guides";

const C = FrontendI18nKeys.common.guideHelp.connect;

/**
 * "How to connect" beside the subscription link (F-414-e): the install guides
 * placed on an operating system (`os:<os>`), opening on the visitor's own. The
 * guides of a system *are* its app choice — one per app, titled by the admin
 * ("v2rayNG", "Hiddify") — so the panel keeps no app list of its own: an app
 * a reseller writes a guide for is offered, and one it hides is not.
 */
export function ConnectGuide() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="mt-2 flex items-center gap-1.5 text-xs font-bold text-primary hover:underline"
      >
        <BookOpen size={14} aria-hidden />
        {t("common", C.open)}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t("common", C.title)}>
        <ConnectBody />
      </Sheet>
    </>
  );
}

/** Mounted only while the sheet is open: nothing is read before, and a reopen starts on the visitor's system again. */
function ConnectBody() {
  const { t } = useLocale();
  const [os, setOs] = useState<GuideOs>(() => osFromUserAgent(navigator.userAgent) ?? "android");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const slot = useSlotGuides(`os:${os}`, () => guideReadApi.forSlot("os", os));

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t("common", C.system)} className="flex flex-wrap gap-2">
        {GUIDE_OSES.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={o === os}
            onClick={() => {
              setOs(o);
              setOpenKey(null);
            }}
            className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
              o === os ? "border-primary bg-primary text-on-accent" : "border-card-border text-text-primary hover:bg-leaf-bg"
            }`}
          >
            {t("common", C.os[o])}
          </button>
        ))}
      </div>
      {slot.guides && slot.guides.length > 1 && openKey === null && <p className="text-xs text-text-secondary">{t("common", C.app)}</p>}
      <GuideList {...slot} empty={t("common", C.none)} open={openKey} onOpen={setOpenKey} />
    </div>
  );
}
