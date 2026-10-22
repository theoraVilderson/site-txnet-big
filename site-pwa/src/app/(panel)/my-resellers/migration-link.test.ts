/**
 * One user's import from an old link, the admin's screen (F-201-h-1, D-63;
 * entitlement `contract.link-import.md`). Billing plans and commits it; the
 * rules held here are the page's own:
 *
 *  - the old link's path is its owner's token: the page names the host, never
 *    the whole link, in a title or a history row;
 *  - a link run the read sent back is a retry, not the panel run's login form;
 *  - the form starts from what the admin corrected, else what the link said;
 *  - it sends only what moved, and a figure put back to what the link said
 *    clears the correction instead of storing the same number twice;
 *  - a link is an absolute http(s) address with a path, as billing takes it.
 */
import { describe, expect, it } from "vitest";
import type { MigrationItem, MigrationRun } from "@/lib/billing-api";
import { linkCorrectionBody, linkFormOf, linkHostOf, linkUrlError, type LinkForm } from "./_lib/migration-link";
import { stageOf } from "./_lib/migration";

const GIB = 1024 ** 3;
const LINK = "https://old.example.com:2096/sub/Ab12Cd34";

const run = (over: Partial<MigrationRun> = {}): MigrationRun => ({
  id: "run-1",
  kind: "link",
  sourceFamily: null,
  sourceAddress: LINK,
  status: "previewed",
  failureReason: null,
  plannedCreate: 1,
  plannedUpdate: 0,
  plannedSkip: 0,
  committedItems: 0,
  failedItems: 0,
  rollbackUntil: null,
  snapshotsPurgedAt: null,
  userId: "user-1",
  variantId: null,
  createdAt: "2026-10-22T08:00:00Z",
  updatedAt: "2026-10-22T08:00:00Z",
  ...over,
});

const item = (over: Partial<MigrationItem> = {}): MigrationItem => ({
  remoteIdentity: "link|https://old.example.com:2096|abc",
  label: "old.example.com",
  inboundRemoteId: "",
  protocol: "vless",
  enabled: true,
  dataLimitBytes: 20 * GIB,
  usedBytes: 5 * GIB,
  expiresAt: "2026-11-01T08:00:00.000Z",
  plannedAction: "create",
  skipReason: null,
  outcome: "pending",
  failureReason: null,
  keptReason: null,
  corrected: { dataLimitBytes: null, usedBytes: null, expiresAt: null },
  balance: { line: null, amount: null, currency: null },
  ...over,
});

describe("naming a link run", () => {
  it("is its host, never the token in its path", () => {
    expect(linkHostOf(run())).toBe("old.example.com");
    expect(linkHostOf(run())).not.toContain("Ab12Cd34");
  });
});

describe("which step a link run is on", () => {
  it("a draft the read sent back is a retry; the rest are a panel run's steps", () => {
    expect(stageOf(run({ status: "draft", failureReason: "source_unavailable" }))).toBe("retry");
    expect(stageOf(run({ status: "previewing" }))).toBe("reading");
    expect(stageOf(run())).toBe("report");
    expect(stageOf(run({ kind: "panel", status: "draft", failureReason: "source_unavailable" }))).toBe("login");
  });
});

describe("the review form", () => {
  it("starts from what the link said, in GB", () => {
    expect(linkFormOf(run(), item())).toEqual({ quotaGb: "20", usedGb: "5", end: expect.any(String), variantId: "" });
  });

  it("starts from the admin's correction where there is one, and the chosen product", () => {
    const form = linkFormOf(run({ variantId: "v-1" }), item({ corrected: { dataLimitBytes: 30 * GIB, usedBytes: null, expiresAt: null } }));
    expect(form).toMatchObject({ quotaGb: "30", usedGb: "5", variantId: "v-1" });
  });

  it("has no end when the link named none", () => {
    expect(linkFormOf(run(), item({ expiresAt: null })).end).toBeNull();
  });
});

describe("what a save sends", () => {
  const base = (): LinkForm => linkFormOf(run(), item());

  it("nothing when nothing moved", () => {
    expect(linkCorrectionBody(base(), run(), item())).toEqual({});
  });

  it("a moved quota and usage in bytes, and the chosen product", () => {
    expect(linkCorrectionBody({ ...base(), quotaGb: "25", usedGb: "2.5", variantId: "v-1" }, run(), item())).toEqual({
      dataLimitBytes: 25 * GIB,
      usedBytes: 2.5 * GIB,
      variantId: "v-1",
    });
  });

  it("clears a correction put back to what the link said", () => {
    const corrected = item({ corrected: { dataLimitBytes: 30 * GIB, usedBytes: null, expiresAt: null } });
    expect(linkCorrectionBody({ ...linkFormOf(run(), corrected), quotaGb: "20" }, run(), corrected)).toEqual({ dataLimitBytes: null });
  });

  it("an end given where the link named none, as an instant", () => {
    const body = linkCorrectionBody({ ...linkFormOf(run(), item({ expiresAt: null })), end: "2026-12-01T23:59" }, run(), item({ expiresAt: null }));
    expect(body.expiresAt).toBe(new Date("2026-12-01T23:59:00").toISOString());
  });

  it("a product unchosen as null", () => {
    expect(linkCorrectionBody({ ...base(), variantId: "" }, run({ variantId: "v-1" }), item())).toEqual({ variantId: null });
  });
});

describe("the link the admin enters", () => {
  it("takes an absolute http(s) address with a path", () => {
    expect(linkUrlError(LINK)).toBeNull();
  });

  it("refuses the bare host, another scheme and no address", () => {
    expect(linkUrlError("https://old.example.com/")).not.toBeNull();
    expect(linkUrlError("vless://u@a:443")).not.toBeNull();
    expect(linkUrlError("  ")).not.toBeNull();
  });
});
