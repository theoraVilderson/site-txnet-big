"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useLiveReread } from "@/hooks/useLiveReread";
import { resellerDomainsApi, type ResellerDomain } from "@/lib/tenant-api";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { DOMAIN_LIVE_EVENTS, domainLiveChannels, domainRefusalKey } from "../../../_lib/domains";

/** A domain route's refusal as its own sentence, else the generic answer for that error. */
export function useDomainMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = domainRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/**
 * One reseller's domains, read and followed live (EDGE-1-f, RT-1-e) — the
 * domains page, the setup wizard's domain step and the import's old-address
 * step (F-204-b). `asked` re-reads loudly; `replace` puts one answered domain
 * in place, or first when it is new.
 */
export function useResellerDomains(id: string, asked = 0) {
  const [domains, setDomains] = useState<ResellerDomain[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // A retry is one more read; the read itself clears the error it replaces.
  const [retried, setRetried] = useState(0);
  const retry = () => setRetried((n) => n + 1);

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

  return { domains, loadError, retry, replace };
}
