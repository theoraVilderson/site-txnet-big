"use client";

import type { ReactNode } from "react";
import { UserRoundX } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useImpersonation } from "../_hooks/useImpersonation";
import { EmptyState } from "./kit";

const K = FrontendI18nKeys.common.impersonation;

/**
 * A page that is the person's own act — a top-up with their own card or
 * gateway, buying a reseller (ADR-0146). While an admin is signed in as them it
 * says so, with `why` (a `common` key) for this page, instead of rendering:
 * the server refuses these routes to an impersonated token anyway.
 */
export function OwnActOnly({ why, children }: { why: string; children: ReactNode }) {
  const { t } = useLocale();
  const impersonation = useImpersonation();
  if (!impersonation) return children;
  return <EmptyState icon={UserRoundX} title={t("common", K.ownActTitle)} body={t("common", why)} />;
}
