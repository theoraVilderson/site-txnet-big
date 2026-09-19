"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, CheckCircle2, Clock, Copy, Loader2, RefreshCw, XCircle, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { authApi } from "@/lib/auth-api";
import { resellerDomainsApi, type DomainPurpose, type DomainStatus, type ResellerDomain } from "@/lib/tenant-api";
import { Select } from "../../../../_components/kit/Select";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { formatInstant } from "../../../../_lib/datetime";
import { Badge } from "../../../../financial/_components/Badge";
import { Alert, Field, input, primaryButton, quietButton } from "../../../../catalog/_components/catalog-ui";
import {
  CHECK_LINE_KEYS,
  DOMAIN_KEYS as K,
  DOMAIN_PURPOSES,
  DOMAIN_STATUS_KEYS,
  canRequestCheck,
  domainHost,
  domainRefusalKey,
} from "../../../_lib/domains";

/** The refusal's own sentence, else the generic answer for that error. */
function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = domainRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

const STATUS_TONE: Record<DomainStatus, { icon: LucideIcon; className: string }> = {
  pending: { icon: Clock, className: "border-gold/20 bg-gold-bg text-gold" },
  verifying: { icon: Loader2, className: "border-gold/20 bg-gold-bg text-gold" },
  verified: { icon: CheckCircle2, className: "border-primary/20 bg-leaf-bg text-primary" },
  revalidating: { icon: AlertCircle, className: "border-gold/20 bg-gold-bg text-gold" },
  failed: { icon: XCircle, className: "border-error-border bg-error-bg text-error" },
};

/**
 * A reseller's custom domains (F-066-w2, `panel-web/contract.resellers.md`
 * "A reseller's workspace"). By the reseller the path names, never the
 * session's tenant (ADR-0064): the owner reaches it from the platform's
 * panel before the reseller has a domain at all.
 *
 *  - **no permission is judged here.** tenant-service admits the owner, a
 *    staff seat or platform support; any other visitor gets its sentence;
 *  - **"check now" only where the route moves the domain** (`pending`,
 *    `failed`). The check itself is the sweep's, within minutes, so a
 *    `verifying` domain offers a re-read, not a second request;
 *  - **nothing is inferred.** Status, records and the last check's lines are
 *    the view's, printed as they came.
 */
export function ResellerDomainsView({ id }: { id: string }) {
  const { t } = useLocale();
  const message = useMessage();

  const [domains, setDomains] = useState<ResellerDomain[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    resellerDomainsApi
      .list(id)
      .then((list) => alive && setDomains(list))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [id, asked]);

  // The name for the title, when the visitor owns it; staff see the plain title.
  useEffect(() => {
    let alive = true;
    authApi
      .ownedResellers()
      .then((r) => alive && setSlug(r.resellers.find((x) => x.id === id)?.slug ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  const replace = (next: ResellerDomain) =>
    setDomains((list) => (list ?? []).some((d) => d.id === next.id)
      ? (list ?? []).map((d) => (d.id === next.id ? next : d))
      : [next, ...(list ?? [])]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">
            {slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <button type="button" className={quietButton} onClick={() => setAsked((n) => n + 1)}>
          <RefreshCw size={12} aria-hidden />
          {t("common", K.refresh)}
        </button>
      </header>

      {loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert>{message(loadError)}</Alert>
          <button type="button" className={primaryButton} onClick={() => setAsked((n) => n + 1)}>
            {t("common", K.reload)}
          </button>
        </div>
      ) : domains === null ? (
        <TableSkeleton rows={3} columns={2} />
      ) : (
        <>
          <AddDomain id={id} onAdded={replace} />
          {domains.length === 0 ? (
            <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">
              {t("common", K.empty)}
            </p>
          ) : (
            domains.map((d) => <DomainCard key={d.id} tenantId={id} domain={d} onChanged={replace} />)
          )}
        </>
      )}
    </div>
  );
}

function AddDomain({ id, onAdded }: { id: string; onAdded: (d: ResellerDomain) => void }) {
  const { t } = useLocale();
  const message = useMessage();
  const [raw, setRaw] = useState("");
  const [purpose, setPurpose] = useState<DomainPurpose>("panel");
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const host = domainHost(raw);
    setError(host ? undefined : K.errors.domain);
    if (!host) return;
    setBusy(true);
    setFailure(null);
    try {
      onAdded(await resellerDomainsApi.add(id, { domainValue: host, purpose }));
      setRaw("");
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-base font-bold text-text-primary">{t("common", K.add.title)}</h2>
      <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
        <Field label={t("common", K.add.domain)} error={error} hint={t("common", K.add.domainHint)}>
          <input
            className={input}
            dir="ltr"
            inputMode="url"
            autoComplete="off"
            placeholder="panel.example.com"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </Field>
        <Field label={t("common", K.add.purpose)}>
          <Select
            value={purpose}
            onChange={(v) => setPurpose(v as DomainPurpose)}
            options={DOMAIN_PURPOSES.map((p) => ({ value: p, label: t("common", K.purposes[p]) }))}
          />
        </Field>
      </div>
      {failure !== null && <Alert>{message(failure)}</Alert>}
      <button type="submit" className={primaryButton} disabled={busy}>
        {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
        {t("common", busy ? K.add.adding : K.add.submit)}
      </button>
    </form>
  );
}

function DomainCard({
  tenantId,
  domain,
  onChanged,
}: {
  tenantId: string;
  domain: ResellerDomain;
  onChanged: (d: ResellerDomain) => void;
}) {
  const { lang, t } = useLocale();
  const message = useMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const when = (iso: string) => formatInstant(iso, lang) ?? iso;
  const tone = STATUS_TONE[domain.status];

  async function check() {
    setBusy(true);
    setFailure(null);
    try {
      onChanged(await resellerDomainsApi.check(tenantId, domain.id));
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span dir="ltr" className="text-base font-bold text-text-primary">
            {domain.domainValue}
          </span>
          <Badge {...tone} label={t("common", DOMAIN_STATUS_KEYS[domain.status])} />
          <span className="text-xs text-text-secondary">{t("common", K.purposes[domain.purpose])}</span>
        </div>
        {canRequestCheck(domain.status) && (
          <button type="button" className={primaryButton} onClick={() => void check()} disabled={busy}>
            {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
            {t("common", K.checkNow)}
          </button>
        )}
      </div>
      <p className="text-xs text-text-secondary">{t("common", K.statusHint[domain.status])}</p>
      {failure !== null && <Alert>{message(failure)}</Alert>}

      <div className="space-y-2">
        <h3 className="text-xs font-bold text-text-secondary">{t("common", K.records.title)}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="text-text-secondary">
              <tr>
                <th className="py-1 pe-3 text-start font-medium">{t("common", K.records.type)}</th>
                <th className="py-1 pe-3 text-start font-medium">{t("common", K.records.name)}</th>
                <th className="py-1 text-start font-medium">{t("common", K.records.value)}</th>
              </tr>
            </thead>
            <tbody className="text-text-primary">
              <RecordRow type={domain.record.type} name={domain.record.name} value={domain.record.value} />
              <RecordRow type="CNAME" name={domain.domainValue} value={domain.cnameTarget} />
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-text-secondary">
        {domain.verifiedAt && <span>{t("common", K.verifiedAt, { date: when(domain.verifiedAt) })} · </span>}
        {domain.lastCheckedAt ? t("common", K.lastCheckedAt, { date: when(domain.lastCheckedAt) }) : t("common", K.neverChecked)}
      </p>

      {domain.lastCheck && domain.lastCheck.lines.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-text-secondary">{t("common", K.lastCheck.title)}</h3>
          <ul className="space-y-1.5 text-xs">
            {domain.lastCheck.lines.map((line) => (
              <li key={line.check} className="flex flex-wrap items-start gap-2">
                {line.ok ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-error" aria-hidden />
                )}
                <span className="font-bold text-text-primary">{t("common", CHECK_LINE_KEYS[line.check])}</span>
                <span className="text-text-secondary">
                  {t("common", K.lastCheck.expected)}:{" "}
                  <span dir="ltr" className="font-mono">{line.expected.join(", ")}</span>
                  {" · "}
                  {t("common", K.lastCheck.found)}:{" "}
                  <span dir="ltr" className="font-mono">
                    {line.found.length > 0 ? line.found.join(", ") : t("common", K.lastCheck.nothing)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RecordRow({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <tr className="border-t border-card-border align-top">
      <td className="py-2 pe-3 font-mono">{type}</td>
      <td className="py-2 pe-3">
        <span dir="ltr" className="break-all font-mono">{name}</span> <CopyButton text={name} />
      </td>
      <td className="py-2">
        <span dir="ltr" className="break-all font-mono">{value}</span> <CopyButton text={value} />
      </td>
    </tr>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={quietButton}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      {t("common", copied ? K.copied : K.copy)}
    </button>
  );
}
