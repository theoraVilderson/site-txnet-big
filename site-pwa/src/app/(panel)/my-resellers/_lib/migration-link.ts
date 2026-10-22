import type { LinkCorrectionBody, MigrationItem, MigrationRun } from "@/lib/billing-api";
import { instantOf, wallTimeOf, type WallTime } from "../../_lib/datetime";
import { driverLabel } from "../../systems/_lib/systems";
import { MIGRATION_KEYS as K } from "./migration";

/**
 * One user's import from an old link, the admin's screen (F-201-h-1, D-63;
 * entitlement `contract.link-import.md`). Billing reads the link, plans and
 * commits; these are the page's rules: how a link run is named, what the
 * review form starts from and what a save sends.
 */

const GIB = 1024 ** 3;
/** billing's `oldLinkSchema`: a link is at most this long. */
const LINK_MAX = 2048;
const WEB_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** A link run's name on the page: its host. The path is its owner's token and is never shown. */
export function linkHostOf(run: Pick<MigrationRun, "sourceAddress">): string {
  return URL.canParse(run.sourceAddress) ? new URL(run.sourceAddress).hostname : "";
}

/** A run's title as a key and its values: a panel by its family and origin, a link by its host alone. */
export function runTitleOf(run: Pick<MigrationRun, "kind" | "sourceFamily" | "sourceAddress">): { key: string; values: Record<string, string> } {
  if (run.kind === "link") return { key: K.link.historyRow, values: { host: linkHostOf(run) } };
  return { key: K.historyRow, values: { family: driverLabel(run.sourceFamily ?? ""), address: run.sourceAddress } };
}

/** The link's error key, or null: absolute http(s) with a path past the root, as billing's `oldLinkSchema` takes it. */
export function linkUrlError(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > LINK_MAX || !URL.canParse(value)) return K.link.invalidUrl;
  const url = new URL(value);
  return WEB_SCHEMES.has(url.protocol) && url.pathname.replace(/\/+$/, "") !== "" ? null : K.link.invalidUrl;
}

/** The review form: GB as typed (0 is unlimited, as the link says it), the end as a wall time, the plan's id or "". */
export interface LinkForm {
  quotaGb: string;
  usedGb: string;
  end: WallTime | null;
  variantId: string;
}

const gbText = (bytes: number | null) => (bytes === null ? "" : String(bytes / GIB));
const bytesOf = (gb: string) => Math.round(Number(gb) * GIB);

/** What the item says now: the admin's figure where they corrected one, else the link's. */
function effectiveOf(item: MigrationItem) {
  return {
    dataLimitBytes: item.corrected.dataLimitBytes ?? item.dataLimitBytes,
    usedBytes: item.corrected.usedBytes ?? item.usedBytes,
    expiresAt: item.corrected.expiresAt ?? item.expiresAt,
  };
}

export function linkFormOf(run: Pick<MigrationRun, "variantId">, item: MigrationItem): LinkForm {
  const now = effectiveOf(item);
  return { quotaGb: gbText(now.dataLimitBytes), usedGb: gbText(now.usedBytes), end: wallTimeOf(now.expiresAt), variantId: run.variantId ?? "" };
}

/** A GB figure the form may send: a number, never negative. */
const isGb = (gb: string) => gb.trim() !== "" && Number.isFinite(Number(gb)) && Number(gb) >= 0;

/** The form's error keys by field; empty when it may be saved. */
export function linkFormErrors(form: LinkForm): Partial<Record<"quotaGb" | "usedGb", string>> {
  return { ...(isGb(form.quotaGb) ? {} : { quotaGb: K.link.invalidGb }), ...(isGb(form.usedGb) ? {} : { usedGb: K.link.invalidGb }) };
}

/**
 * What a save sends: only the fields that moved. A figure put back to what the
 * link said is a cleared correction (null), so the admin's word is kept only
 * where it differs from the link's.
 */
export function linkCorrectionBody(form: LinkForm, run: Pick<MigrationRun, "variantId">, item: MigrationItem): LinkCorrectionBody {
  const was = linkFormOf(run, item);
  const body: LinkCorrectionBody = {};
  const figure = (gb: string, read: number | null) => {
    const bytes = bytesOf(gb);
    return bytes === read ? null : bytes;
  };
  if (form.quotaGb !== was.quotaGb) body.dataLimitBytes = figure(form.quotaGb, item.dataLimitBytes);
  if (form.usedGb !== was.usedGb) body.usedBytes = figure(form.usedGb, item.usedBytes);
  if (form.end !== was.end) {
    const at = form.end === null ? null : instantOf(form.end);
    body.expiresAt = at === null || at === item.expiresAt ? null : at;
  }
  if (form.variantId !== was.variantId) body.variantId = form.variantId || null;
  return body;
}
