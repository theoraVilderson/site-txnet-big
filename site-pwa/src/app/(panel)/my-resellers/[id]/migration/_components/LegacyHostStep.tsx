"use client";

import { useEffect, useState } from "react";
import { Link2, Plus, Radar } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { LegacyHost, LegacyTestResult, MigrationRunsApi } from "@/lib/billing-api";
import { resellerDomainsApi, type ResellerDomain } from "@/lib/tenant-api";
import { DOMAIN_KEYS } from "../../../_lib/domains";
import { MIGRATION_KEYS as K, legacyStepOf, reasonKey, servesOnlySubPath } from "../../../_lib/migration";
import { DomainCard } from "../../domains/_components/ResellerDomainsView";
import { useDomainMessage, useResellerDomains } from "../../domains/_hooks/useResellerDomains";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { Alert, Button } from "../../../../_components/kit";

const L = K.legacy;

/**
 * The import's last step (F-204-b, D-63; panel-web `contract.migration.md`
 * rule 9): every old host the reseller's imported users hold links on,
 * brought here as a `legacy_sub` domain — added, its TXT and CNAME, check
 * now, all as the domains page shows them (`DomainCard`) — and, once live,
 * a test of one imported user's old link fetched from outside. The hosts are
 * billing's; the domain is tenant-service's and followed live (EDGE-1-f).
 */
export function LegacyHostStep({ api, tenantId, family }: { api: MigrationRunsApi; tenantId: string; family: string }) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const domainMessage = useDomainMessage();
  const [hosts, setHosts] = useState<LegacyHost[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { domains, loadError, replace } = useResellerDomains(tenantId);

  useEffect(() => {
    let alive = true;
    api.legacyHosts().then(
      (r) => alive && setHosts(r.hosts),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <section className="space-y-4 border-t border-card-border pt-5">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
          <Link2 size={14} aria-hidden />
          {t("common", L.title)}
        </h3>
        <p className="text-xs text-text-secondary">{t("common", L.intro)}</p>
      </div>
      {servesOnlySubPath(family) && <Alert tone="info">{t("common", L.hiddify)}</Alert>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      {loadError !== null && <Alert tone="error">{domainMessage(loadError)}</Alert>}
      {error === null && loadError === null && (hosts === null || domains === null) && <TableSkeleton rows={2} columns={2} />}
      {hosts?.length === 0 && <p className="text-sm text-text-secondary">{t("common", L.empty)}</p>}
      {hosts &&
        domains &&
        hosts.map((h) => <OldHost key={h.host} api={api} tenantId={tenantId} host={h} domains={domains} onDomain={replace} />)}
    </section>
  );
}

/** One old host at the step it is on (`legacyStepOf`). */
function OldHost({
  api,
  tenantId,
  host,
  domains,
  onDomain,
}: {
  api: MigrationRunsApi;
  tenantId: string;
  host: LegacyHost;
  domains: readonly ResellerDomain[];
  onDomain: (d: ResellerDomain) => void;
}) {
  const { t } = useLocale();
  const step = legacyStepOf(host.host, domains);
  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">
        <span dir="ltr" className="font-mono font-bold text-text-primary">{host.host}</span>
        {" · "}
        {t("common", L.links, { count: String(host.links) })}
      </p>
      {step.kind === "add" && <AddOldHost tenantId={tenantId} host={host.host} onAdded={onDomain} />}
      {step.kind === "otherPurpose" && (
        <Alert tone="warning">{t("common", L.otherPurpose, { purpose: t("common", DOMAIN_KEYS.purposes[step.domain.purpose]) })}</Alert>
      )}
      {(step.kind === "pointing" || step.kind === "live") && <DomainCard tenantId={tenantId} domain={step.domain} onChanged={onDomain} />}
      {step.kind === "pointing" && <p className="text-xs text-text-secondary">{t("common", L.waiting)}</p>}
      {step.kind === "live" && <TestOldLink api={api} host={host.host} />}
    </div>
  );
}

/** Adds the old host as the reseller's `legacy_sub` domain (tenant rule 7); its records then show in its card. */
function AddOldHost({ tenantId, host, onAdded }: { tenantId: string; host: string; onAdded: (d: ResellerDomain) => void }) {
  const { t } = useLocale();
  const message = useDomainMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function add() {
    setBusy(true);
    setFailure(null);
    try {
      onAdded(await resellerDomainsApi.add(tenantId, { domainValue: host, purpose: "legacy_sub" }));
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button size="sm" loading={busy} onClick={() => void add()} icon={<Plus size={12} aria-hidden />}>
        {t("common", busy ? L.adding : L.add)}
      </Button>
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
    </div>
  );
}

/** One imported link on the live host, fetched from outside by billing through network (F-204-b); its result said in a sentence. */
function TestOldLink({ api, host }: { api: MigrationRunsApi; host: string }) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LegacyTestResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  async function test() {
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      setResult(await api.testLegacyHost(host));
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" loading={busy} onClick={() => void test()} icon={<Radar size={12} aria-hidden />}>
        {t("common", busy ? L.testing : L.test)}
      </Button>
      {result && <TestResult result={result} />}
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
    </div>
  );
}

function TestResult({ result }: { result: LegacyTestResult }) {
  const { t } = useLocale();
  if (result.outcome === "failed") {
    const key = reasonKey(L.failure, result.reason);
    return <Alert tone="error">{key ? t("common", key) : t("common", L.failure.other, { reason: result.reason })}</Alert>;
  }
  if (result.servers === 0) return <Alert tone="warning">{t("common", L.okEmpty)}</Alert>;
  const servers = String(result.servers);
  return (
    <Alert tone="success">
      <span dir="auto">{result.label ? t("common", L.ok, { label: result.label, servers }) : t("common", L.okAnonymous, { servers })}</span>
    </Alert>
  );
}
