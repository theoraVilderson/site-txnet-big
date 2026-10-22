"use client";

import { useState } from "react";
import { Link2, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationRun, MigrationRunsApi } from "@/lib/billing-api";
import type { UserSearchHit } from "@/lib/auth-api";
import { UserSearch } from "../../../../groups/_components/UserSearch";
import { MIGRATION_KEYS as K } from "../../../_lib/migration";
import { linkUrlError } from "../../../_lib/migration-link";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { Alert, Button, Field, Input } from "../../../../_components/kit";

/**
 * A new link run (F-201-h-1, entitlement `contract.link-import.md`): the
 * user's old link and which of the reseller's users it is for, found through
 * its own users list. Billing reads the link at once; the card follows.
 */
export function LinkImportForm({ api, tenantId, onDone, onCancel }: { api: MigrationRunsApi; tenantId: string; onDone: (run: MigrationRun) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const [url, setUrl] = useState("");
  const [user, setUser] = useState<UserSearchHit | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const urlError = linkUrlError(url);

  async function submit() {
    setTried(true);
    if (busy || urlError || !user) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.createLink({ url: url.trim(), userId: user.id }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="link-import">
      <h3 id="link-import" className="text-sm font-bold text-text-primary">
        {t("common", K.link.newLink)}
      </h3>
      <p className="text-xs text-text-secondary">{t("common", K.link.intro)}</p>
      <Field label={t("common", K.link.url)} hint={t("common", K.link.urlHint)} error={tried && urlError ? t("common", urlError) : undefined}>
        <Input dir="ltr" value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <div className="space-y-2">
        <p className="text-sm font-bold text-text-primary">{t("common", K.link.user)}</p>
        {user ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-card-border px-3 py-2">
            <span className="truncate text-sm text-text-primary">
              {user.fullName}
              {user.username && (
                <span className="text-text-secondary" dir="ltr">
                  {" "}
                  @{user.username}
                </span>
              )}
            </span>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => setUser(null)}>
              {t("common", K.link.userChange)}
            </Button>
          </div>
        ) : (
          <UserSearch via="reseller" tenantId={tenantId} busy={busy} onAdd={setUser} placeholder={t("common", K.link.userSearch)} />
        )}
        {tried && !user && <p className="text-xs text-error">{t("common", K.link.chooseUser)}</p>}
      </div>
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void submit()} icon={<Link2 size={14} aria-hidden />}>
          {t("common", K.link.read)}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel} icon={<X size={14} aria-hidden />}>
          {t("common", K.back)}
        </Button>
      </div>
    </section>
  );
}
