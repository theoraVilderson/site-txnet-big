"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { resellerDomainsApi, type DomainPath, type PathOffer, type ResellerDomain } from "@/lib/tenant-domains-api";
import { formatList } from "../../../../_lib/digits";
import { Alert, RadioCards, SegmentedControl } from "../../../../_components/kit";
import { DOMAIN_KEYS as K, PATH_KEYS, edgeLabelKey, isOwnEdge, offersInOrder, ownEdgeSettings, type OwnEdgeSetting } from "../../../_lib/domains";
import { useDomainMessage } from "../_hooks/useResellerDomains";
import { Copyable } from "./Copyable";

/**
 * How a domain reaches us (NIN-1-e3, ADR-0165 point 7; panel-web
 * `contract.reseller-domains.md` D9–D12): our Cloudflare or the reseller's own
 * account at an approved edge — chosen when adding, changed on the card, and
 * what to set in each. Every word is a locale key; the edges' names come from
 * the platform's list (`paths`), so a new edge needs no edit here.
 */

/** The approved edges' names, as people know them, in the reader's list form. */
export function useEdgeNames(edges: readonly string[]): string {
  const { lang, t } = useLocale();
  return formatList(edges.map((n) => {
    const key = edgeLabelKey(n);
    return key ? t("common", key) : n;
  }), lang);
}

/** The paths offered, as cards with what each means; only ours when no own edge is offered. */
export function PathChoice({ offers, value, onChange }: { offers: PathOffer[]; value: DomainPath; onChange: (p: DomainPath) => void }) {
  const { t } = useLocale();
  const edges = useEdgeNames(offers.find((o) => isOwnEdge(o.path))?.edges ?? []);
  if (offers.length < 2) return null;
  const hint: Record<DomainPath, string> = { platform_cdn: K.path.platformHint, own_edge: K.path.ownHint };
  return (
    <RadioCards
      ariaLabel={t("common", K.path.label)}
      value={value}
      onChange={onChange}
      options={offersInOrder(offers).map((o) => ({ value: o.path, label: t("common", PATH_KEYS[o.path]), description: t("common", hint[o.path], { edges }) }))}
    />
  );
}

/** Said plainly on every domain on our Cloudflare: it closes with the cut, as would an unlisted CDN in front. */
export function CutWarning({ offers }: { offers: PathOffer[] }) {
  const { t } = useLocale();
  const edges = useEdgeNames(offers.find((o) => isOwnEdge(o.path))?.edges ?? []);
  return <Alert tone="warning">{t("common", K.path.cut, { edges })}</Alert>;
}

/** The card's path, changed in place; a verified domain keeps routing while the new one is checked. */
export function PathControl({ tenantId, domain, offers, onChanged }: { tenantId: string; domain: ResellerDomain; offers: PathOffer[]; onChanged: (d: ResellerDomain) => void }) {
  const { t } = useLocale();
  const message = useDomainMessage();
  const [failure, setFailure] = useState<unknown>(null);
  if (offers.length < 2) return null;
  async function change(path: DomainPath) {
    setFailure(null);
    try {
      onChanged(await resellerDomainsApi.setPath(tenantId, domain.id, path));
    } catch (e) {
      setFailure(e);
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold text-text-secondary">{t("common", K.path.label)}</h3>
        <SegmentedControl
          size="sm"
          ariaLabel={t("common", K.path.change)}
          value={domain.path}
          onChange={(p) => void change(p)}
          options={offersInOrder(offers).map((o) => ({ value: o.path, label: t("common", PATH_KEYS[o.path]) }))}
        />
      </div>
      {domain.switching && <p className="text-xs text-text-secondary">{t("common", K.path.switching)}</p>}
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
    </div>
  );
}

/** What to set in the reseller's own edge account (D10): target, port, HTTPS, the visitor's host, cloud and WebSockets on. */
export function OwnEdgeSettings({ domain, offer }: { domain: ResellerDomain; offer: PathOffer }) {
  const { t } = useLocale();
  const edges = useEdgeNames(offer.edges);
  const label: Record<OwnEdgeSetting["id"], string> = { origin: K.own.origin, port: K.own.port, protocol: K.own.protocol, host: K.own.host, cloud: K.own.cloud, websocket: K.own.websocket };
  return (
    <div className="space-y-2 rounded-xl border border-card-border p-3 text-xs">
      <h3 className="font-bold text-text-secondary">{t("common", K.own.title)}</h3>
      <p className="text-text-secondary">{t("common", K.own.intro, { edges })}</p>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr]">
        {ownEdgeSettings(offer, domain.domainValue).map((r) => (
          <div key={r.id} className="contents">
            <dt className="text-text-secondary">{t("common", label[r.id])}</dt>
            <dd className="text-text-primary">
              {r.copy ? <Copyable text={r.value}>{r.key && <span className="block text-3xs text-text-secondary">{t("common", r.key)}</span>}</Copyable> : r.value || (r.key ? t("common", r.key) : "")}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-text-secondary">{t("common", K.own.cache)}</p>
    </div>
  );
}

/** What a reseller's own CDN in front of the domain must send (ADR-0129 (4), ADR-0063). */
export function CdnSettings({ domain }: { domain: ResellerDomain }) {
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
