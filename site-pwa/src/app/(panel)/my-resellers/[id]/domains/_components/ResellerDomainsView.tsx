"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Check, CheckCircle2, Clock, Copy, Loader2, RefreshCw, XCircle, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useLiveReread } from "@/hooks/useLiveReread";
import { authApi } from "@/lib/auth-api";
import { resellerDomainsApi, type DomainPurpose, type DomainStatus, type EdgeStatus, type ResellerDomain } from "@/lib/tenant-api";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { Select } from "../../../../_components/kit/Select";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { DataTable } from "../../../../_components/kit/DataTable";
import { formatInstant } from "../../../../_lib/datetime";
import { Badge } from "../../../../financial/_components/Badge";
import { Field } from "../../../../catalog/_components/catalog-ui";
import {
  CHECK_LINE_KEYS,
  DOMAIN_KEYS as K,
  DOMAIN_LIVE_EVENTS,
  DOMAIN_PURPOSES,
  DOMAIN_STATUS_KEYS,
  EDGE_HINT_KEYS,
  EDGE_STATUS_KEYS,
  canRequestCheck,
  domainHost,
  domainLiveChannels,
  domainRefusalKey,
  dnsName,
  isApex,
  isLive,
  isRoutable,
} from "../../../_lib/domains";
import { Alert, Button, IconButton, Input, PageHeader } from "../../../../_components/kit";

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

const WAITING = { icon: Loader2, className: "border-gold/20 bg-gold-bg text-gold" };
const EDGE_TONE: Record<EdgeStatus, { icon: LucideIcon; className: string }> = {
  none: { icon: Clock, className: "border-gold/20 bg-gold-bg text-gold" },
  registering: WAITING,
  issuing: WAITING,
  issued: { icon: CheckCircle2, className: "border-primary/20 bg-leaf-bg text-primary" },
  renew_failed: { icon: XCircle, className: "border-error-border bg-error-bg text-error" },
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
 *    the view's, printed as they came;
 *  - **it follows the sweep live** (EDGE-1-f, RT-1-e): `tenant.domain.changed`
 *    on the owner's `user:` channel or the platform's `tenant:` channel makes
 *    it re-read the list quietly. The refresh button stays for "check now".
 */
export function ResellerDomainsView({ id }: { id: string }) {
  const { t } = useLocale();
  const [slug, setSlug] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);

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

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader
        title={slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            <Button variant="quiet" size="sm" onClick={() => setAsked((n) => n + 1)} icon={<RefreshCw size={12} aria-hidden />}>
            {t("common", K.refresh)}
          </Button>
          </>
        }
      />
      <DomainsPanel id={id} asked={asked} />
    </div>
  );
}

/**
 * The page's body without its frame — the add form and one card per domain,
 * read and followed live — shared by the page and the setup wizard's domain
 * step (UX-2-c). `asked` re-reads it loudly.
 */
export function DomainsPanel({ id, asked = 0 }: { id: string; asked?: number }) {
  const { t } = useLocale();
  const message = useMessage();

  const [domains, setDomains] = useState<ResellerDomain[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retried, setRetried] = useState(0);
  const retry = () => {
    setLoadError(null);
    setRetried((n) => n + 1);
  };

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
  }, [id, asked, retried]);

  // A live event is a hint, not the record: the list is read again with no
  // skeleton, and a failed read keeps what is on screen.
  const { me, group } = usePanelSession();
  const [own, platform] = domainLiveChannels(group?.current.userId ?? null, me);
  const quietRead = () => {
    resellerDomainsApi.list(id).then(setDomains, () => undefined);
  };
  useLiveReread(own, DOMAIN_LIVE_EVENTS, quietRead);
  useLiveReread(platform, DOMAIN_LIVE_EVENTS, quietRead);

  const replace = (next: ResellerDomain) =>
    setDomains((list) => (list ?? []).some((d) => d.id === next.id)
      ? (list ?? []).map((d) => (d.id === next.id ? next : d))
      : [next, ...(list ?? [])]);

  if (loadError !== null) {
    return (
      <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
        <Alert tone="error">{message(loadError)}</Alert>
        <Button variant="primary" size="sm" onClick={retry}>
          {t("common", K.reload)}
        </Button>
      </div>
    );
  }
  if (domains === null) return <TableSkeleton rows={3} columns={2} />;
  return (
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
    const problem = !host ? K.errors.domain : isApex(host) ? K.errors.apex : undefined;
    setError(problem);
    if (!host || problem) return;
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
          <Input
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
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
      <Button variant="primary" size="sm" type="submit" loading={busy}>
        {t("common", busy ? K.add.adding : K.add.submit)}
      </Button>
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
  // A verified domain whose edge failed is started over by the same route.
  const checkable = canRequestCheck(domain.status) || (isRoutable(domain.status) && domain.edge.status === "failed");

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
          {isLive(domain.status, domain.edge.status) && <Badge {...EDGE_TONE.issued} label={t("common", K.live)} />}
          <span className="text-xs text-text-secondary">{t("common", K.purposes[domain.purpose])}</span>
        </div>
        {checkable && (
          <Button variant="primary" size="sm" onClick={() => void check()} loading={busy}>
            {t("common", K.checkNow)}
          </Button>
        )}
      </div>
      <p className="text-xs text-text-secondary">{t("common", K.statusHint[domain.status])}</p>
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}

      <div className="space-y-2">
        <h3 className="text-xs font-bold text-text-secondary">{t("common", K.records.title)}</h3>
        <p className="text-xs text-text-secondary">{t("common", K.records.zoneHint, { zone: dnsName(domain.domainValue).zone })}</p>
        <DataTable
          label={t("common", K.records.title)}
          compact
          bare
          rowClassName="align-top"
          rows={[
            { type: domain.record.type, name: domain.record.name, value: domain.record.value },
            { type: "CNAME", name: domain.domainValue, value: domain.cnameTarget },
            ...(domain.edge.record ? [domain.edge.record] : []),
          ]}
          rowKey={(r) => `${r.type}|${r.name}`}
          columns={[
            { id: "type", header: t("common", K.records.type), cell: (r) => r.type, className: "font-mono" },
            { id: "name", header: t("common", K.records.name), cell: (r) => <RecordName name={r.name} /> },
            { id: "value", header: t("common", K.records.value), cell: (r) => <Copyable text={r.value} /> },
          ]}
        />
        {domain.edge.record && <p className="text-xs text-text-secondary">{t("common", K.records.edgeHint)}</p>}
      </div>

      {(isRoutable(domain.status) || domain.edge.status !== "none") && <EdgeStep domain={domain} />}

      <CdnSettings domain={domain} />

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

/** The domain's step at the CDN after `verified` (ADR-0129 (6)), and the provider's reason when it failed. */
function EdgeStep({ domain }: { domain: ResellerDomain }) {
  const { t } = useLocale();
  const { status, lastError } = domain.edge;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold text-text-secondary">{t("common", K.edge.title)}</h3>
        <Badge {...EDGE_TONE[status]} label={t("common", EDGE_STATUS_KEYS[status])} />
      </div>
      <p className="text-xs text-text-secondary">{t("common", EDGE_HINT_KEYS[status])}</p>
      {lastError && (
        <p className="text-xs text-error">
          {t("common", K.edge.why)}: <span dir="ltr" className="font-mono">{lastError}</span>
        </p>
      )}
    </div>
  );
}

/** What a reseller's own CDN in front of the domain must send (ADR-0129 (4), ADR-0063). */
function CdnSettings({ domain }: { domain: ResellerDomain }) {
  const { t } = useLocale();
  const rows = [
    { id: "origin", label: t("common", K.cdn.origin), value: domain.cnameTarget, copy: true },
    { id: "host", label: t("common", K.cdn.host), value: domain.domainValue, copy: true },
    { id: "sni", label: t("common", K.cdn.sni), value: domain.domainValue, copy: true },
    { id: "websocket", label: t("common", K.cdn.websocket), value: t("common", K.cdn.websocketOn), copy: false },
  ];
  return (
    <details className="rounded-xl border border-card-border p-3 text-xs">
      <summary className="cursor-pointer font-bold text-text-secondary">{t("common", K.cdn.title)}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-text-secondary">{t("common", K.cdn.intro)}</p>
        <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr]">
          {rows.map((r) => (
            <div key={r.id} className="contents">
              <dt className="text-text-secondary">{r.label}</dt>
              <dd className="text-text-primary">{r.copy ? <Copyable text={r.value} /> : r.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-text-secondary">{t("common", K.cdn.cache)}</p>
      </div>
    </details>
  );
}

/** The name the DNS panel takes, copied as is; the full name under it for a panel that wants that (EDGE-1-o). */
function RecordName({ name }: { name: string }) {
  const { t } = useLocale();
  const { short, full } = dnsName(name);
  return (
    <Copyable text={short}>
      <span className="mt-0.5 block text-[10px] leading-4 text-text-secondary">
        {t("common", K.records.full)}{" "}
        <span dir="ltr" className="break-all font-mono">{full}</span>
      </span>
    </Copyable>
  );
}

/**
 * The copy button first, at a fixed place, so every row's button sits in one
 * column whatever the text's length; the text (left-to-right) takes the rest.
 */
function Copyable({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <span className="flex items-start gap-2">
      <CopyButton text={text} />
      <span className="min-w-0 flex-1 pt-1">
        <span dir="ltr" className="block break-all font-mono">{text}</span>
        {children}
      </span>
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const label = t("common", copied ? K.copied : K.copy);
  return (
    <IconButton
      size="sm"
      aria-label={label}
      title={label}
      className="shrink-0"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      icon={copied ? <Check size={14} aria-hidden className="text-primary" /> : <Copy size={14} aria-hidden />}
    />
  );
}
