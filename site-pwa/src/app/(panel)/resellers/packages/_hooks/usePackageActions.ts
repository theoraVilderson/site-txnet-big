"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { tenantApi, type TenantPackage } from "@/lib/tenant-api";
import { useMessage } from "../../_components/resellers-ui";
import { PACKAGE_KEYS as K } from "../../_lib/packages";
import { useConfirm } from "../../../_components/kit";

/**
 * Withdraw / offer again and "apply to subscribers" (contract.reseller-packages
 * rule 8), the same on the list and on a package's page: `isActive` alone, and
 * an apply asked once — a removed feature is taken away now, not at renewal.
 * `reload` runs after each, so the page reads the package as it now is.
 */
export function usePackageActions(reload: () => void) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const message = useMessage();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function act(p: TenantPackage, run: () => Promise<string>) {
    setBusy(p.id);
    setFailure(null);
    setNotice(null);
    try {
      setNotice(await run());
      reload();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(null);
    }
  }

  const toggleActive = (p: TenantPackage, name: string) =>
    act(p, async () => {
      await tenantApi.updatePackage(p.id, { isActive: !p.isActive });
      return t("common", K.saved, { name });
    });

  const apply = async (p: TenantPackage) => {
    if (!(await confirm({ title: t("common", K.applyConfirm), confirmLabel: t("common", K.apply) }))) return;
    return act(p, async () => {
      const answer = await tenantApi.applyPackage(p.id);
      return t("common", K.applyDone, { count: answer.subscribers });
    });
  };

  return { busy, notice, failure, setNotice, setFailure, toggleActive, apply };
}
