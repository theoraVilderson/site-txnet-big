"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { resellerGrantsApi, type ResellerUserGrantsApi } from "@/lib/billing-api";
import { GRANT_KEYS as G, issueBody } from "../../../../_lib/grant-actions";
import { USER_KEYS, issuableProducts } from "../../../../_lib/users";
import { useUserMessage } from "./useUserMessage";
import { Alert, Button, Field, Input, NativeSelect } from "../../../../../_components/kit";
import { panel } from "./GrantActions";

interface IssuableVariant {
  id: string;
  label: string;
}

/**
 * Give the user a new service by hand (F-311-o): a variant of the reseller's
 * own catalog, read the first time the form opens — its products, then each
 * one's variants, the switched-off left out. One `requestId` per opened form,
 * so a double click issues once; billing refuses what it could not place.
 */
export function IssueGrant({
  api,
  tenantId,
  userId,
  texts,
  onIssued,
}: {
  api: ResellerUserGrantsApi;
  tenantId: string;
  /** Whom the issue is for: a product sold to groups they are in none of is not offered (PT-1-b). */
  userId: string;
  texts: Record<string, string>;
  onIssued: () => void;
}) {
  const { t } = useLocale();
  const message = useUserMessage();
  const [open, setOpen] = useState(false);
  const [variants, setVariants] = useState<IssuableVariant[] | null>(null);
  const [variantId, setVariantId] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);

  const body = issueBody(variantId, requestId, reason);

  async function readVariants() {
    // The users-admin door's list (F-311-ab2, D-57): no `catalog.manage`, the platform's too.
    const products = issuableProducts(await resellerGrantsApi(tenantId).usersCatalog(userId));
    return products.flatMap((p) =>
      p.variants.map((v) => {
        const name = texts[v.nameKey ?? p.nameKey] || texts[p.nameKey];
        return { id: v.id, label: name ? `${name} · ${v.sku}` : v.sku };
      }),
    );
  }

  function start() {
    setOpen(true);
    setVariantId("");
    setReason("");
    setRequestId(crypto.randomUUID());
    setDone(null);
    setError(null);
    if (variants !== null) return;
    readVariants()
      .then(setVariants)
      .catch((e) => {
        setOpen(false);
        setError(e);
      });
  }

  async function send() {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api.issue(body);
      setDone(answer.issued);
      setOpen(false);
      onIssued();
    } catch (e) {
      console.error(e);
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="primary" size="sm" disabled={busy} onClick={start} icon={<Plus size={12} aria-hidden />}>
        {t("common", G.label.issue)}
      </Button>
      {open && (
        <form
          className={panel}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="text-xs text-text-secondary">{t("common", G.confirm.issue)}</p>
          {variants === null ? (
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={12} className="animate-spin" aria-hidden />
              {t("common", G.field.variantsLoading)}
            </p>
          ) : variants.length === 0 ? (
            <p className="text-xs text-text-secondary">{t("common", G.field.variantsNone)}</p>
          ) : (
            <label className="block text-xs font-bold text-text-secondary">
              {t("common", G.field.variant)}
              <NativeSelect className="mt-1" value={variantId} onChange={(e) => setVariantId(e.target.value)}>
                <option value="">{t("common", G.field.variantPick)}</option>
                {variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          <Field label={t("common", G.field.reasonOptional)}>
            <Input className="mt-1" value={reason} maxLength={500} placeholder={t("common", G.field.reasonPlaceholder)} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" type="submit" disabled={body === null} loading={busy}>
              {t("common", G.submit.issue)}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>
              {t("common", USER_KEYS.actions.cancel)}
            </Button>
          </div>
        </form>
      )}
      {done !== null && (
        <p role="status" className="text-xs font-bold text-primary">
          {t("common", done ? G.done.issue : G.done.issueRepeat)}
        </p>
      )}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </div>
  );
}
