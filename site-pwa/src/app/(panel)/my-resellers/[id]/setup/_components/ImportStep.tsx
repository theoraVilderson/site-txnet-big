"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { resellerOnboardingApi, type OnboardingStep } from "@/lib/tenant-onboarding-api";
import { Alert, Button, buttonClass } from "../../../../_components/kit";
import { ONBOARDING_KEYS as K, onboardingRefusalKey, stepHref } from "../../../_lib/onboarding";
import { useWorkspaceSelf } from "../../../_lib/workspace";

const I = K.wizard.import;

/**
 * «Bring my users», the optional first step (F-213): the way to this
 * reseller's migration page, or "I have no users to bring" — the one
 * onboarding answer that is stored, and so the one that can be taken back.
 * Done by a committed import, there is nothing to skip or undo. Every change
 * re-reads the checklist (`onChanged`), as the other steps' saves do.
 */
export function ImportStep({ id, step, onChanged }: { id: string; step: OnboardingStep; onChanged: () => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const self = useWorkspaceSelf(id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const href = stepHref("import", id, self);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const refusal = error === null ? null : onboardingRefusalKey(error);

  return (
    <div className="space-y-4">
      {error !== null && <Alert tone="error">{refusal ? t("common", refusal) : errorMessage(error)}</Alert>}
      {step.skipped ? (
        <div className="space-y-3">
          <Alert tone="info">{t("common", I.skipped)}</Alert>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => void act(() => resellerOnboardingApi.unskip(id, "import"))}>
            {t("common", I.undo)}
          </Button>
        </div>
      ) : step.done ? (
        <Alert tone="success">{t("common", I.done)}</Alert>
      ) : (
        <div className="flex flex-wrap gap-2">
          {href && (
            <Link href={href} className={buttonClass({ variant: "primary", size: "sm" })}>
              {t("common", I.open)}
            </Link>
          )}
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => void act(() => resellerOnboardingApi.skip(id, "import"))}>
            {t("common", I.skip)}
          </Button>
        </div>
      )}
    </div>
  );
}
