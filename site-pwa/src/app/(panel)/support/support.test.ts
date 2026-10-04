import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import type { SupportMessage } from "@/lib/support-api";
import { PANEL_SUPPORT, panelSupportThreadPath } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import {
  SCAN_KEYS,
  STATUS_KEYS,
  SUPPORT_KEYS,
  applySupportEvent,
  mergeMessages,
  readSupportEvent,
  threadActions,
  typingGate,
  type ThreadState,
} from "./_lib/support";

/**
 * The user's support page (F-033-o) over support-service's `/api/support/*`
 * and its `support:<id>` channel (F-034, ADR-0114). What breaks with nothing
 * red anywhere:
 *  - **a message shown twice, or out of order** — the sender's own answer and
 *    the channel's event both carry it, and a re-read after a gap overlaps;
 *  - **a lost event read as nothing happened** — the channel is at-most-once,
 *    so a message whose `seq` skips one must make the page re-read the thread;
 *  - **another thread's event on this screen** — every event names its
 *    conversation, and only this one's is applied;
 *  - **an action offered that support refuses** — writing on a closed thread,
 *    rating twice, reopening one that is not closed;
 *  - **a status or scan state with no sentence** — every value of support's
 *    Prisma enums has one in both languages.
 */
const REPO = join(__dirname, "../../../../..");
const LOCALES = join(REPO, "locales/frontend/langs");
const PRISMA = readFileSync(join(REPO, "txnet-backend/prisma/domains/support.prisma"), "utf8");

const CONV = "aaaaaaaa-0000-4000-8000-0000000000c1";
const OTHER = "aaaaaaaa-0000-4000-8000-0000000000c2";

const msg = (seq: number, over: Partial<SupportMessage> = {}): SupportMessage => ({
  id: `m-${seq}`,
  seq,
  senderKind: "user",
  mine: true,
  body: `body ${seq}`,
  createdAt: "2026-10-04T10:00:00.000Z",
  attachments: [],
  ...over,
});

const state = (over: Partial<ThreadState> = {}): ThreadState => ({
  conversationId: CONV,
  status: "pending_agent",
  messages: [msg(1), msg(2, { senderKind: "agent", mine: false })],
  seenUpToSeq: 0,
  agentTypingUntil: 0,
  ...over,
});

function enumValues(name: string): string[] {
  const block = PRISMA.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))?.[1] ?? "";
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-z_]+$/.test(l));
}

describe("messages are one list, by seq", () => {
  it("drops a message already held and orders by seq", () => {
    const merged = mergeMessages([msg(1), msg(3)], [msg(3), msg(2)]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("keeps the fresher copy of a message read twice — its attachment URL was minted later", () => {
    const old = msg(1, { attachments: [{ id: "a1", fileName: "x.png", contentType: "image/png", sizeBytes: 1, scanStatus: "pending", url: null, urlExpiresAt: null, expired: false }] });
    const fresh = msg(1, { attachments: [{ ...old.attachments[0], scanStatus: "clean", url: "/api/public/tenant/private-files/x" }] });
    expect(mergeMessages([old], [fresh])[0].attachments[0].url).toBe("/api/public/tenant/private-files/x");
  });
});

describe("the channel's events", () => {
  const event = (payload: Record<string, unknown>) => readSupportEvent({ conversationId: CONV, ...payload }, CONV);

  it("ignores another conversation's event and any shape it does not know", () => {
    expect(readSupportEvent({ kind: "support.typing", conversationId: OTHER, senderKind: "agent", expiresInMs: 6000 }, CONV)).toBeNull();
    expect(event({ kind: "support.unknown" })).toBeNull();
    expect(event({ kind: "support.message", status: "pending_user", message: { seq: "3" } })).toBeNull();
    expect(readSupportEvent("nonsense", CONV)).toBeNull();
  });

  it("appends the next message, marks an agent's as not mine, and takes the status it carries", () => {
    const e = event({ kind: "support.message", status: "pending_user", message: { ...msg(3), mine: undefined, senderKind: "agent" } });
    const { next, reread } = applySupportEvent(state(), e!, 0);
    expect(reread).toBe(false);
    expect(next.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(next.messages[2].mine).toBe(false);
    expect(next.status).toBe("pending_user");
  });

  it("asks for a re-read when a message skips a seq — the channel lost one", () => {
    const e = event({ kind: "support.message", status: "pending_user", message: { ...msg(5), senderKind: "agent" } });
    expect(applySupportEvent(state(), e!, 0).reread).toBe(true);
  });

  it("clears the agent's typing when their message lands", () => {
    const e = event({ kind: "support.message", status: "pending_user", message: { ...msg(3), senderKind: "agent" } });
    expect(applySupportEvent(state({ agentTypingUntil: 9_999 }), e!, 1_000).next.agentTypingUntil).toBe(0);
  });

  it("shows the agent typing for the time the event names, never the user's own", () => {
    const agent = event({ kind: "support.typing", senderKind: "agent", expiresInMs: 6000 });
    const own = event({ kind: "support.typing", senderKind: "user", expiresInMs: 6000 });
    expect(applySupportEvent(state(), agent!, 1_000).next.agentTypingUntil).toBe(7_000);
    expect(applySupportEvent(state(), own!, 1_000).next.agentTypingUntil).toBe(0);
  });

  it("moves 'seen' forward on an agent's read only", () => {
    const read = (readerKind: string, lastReadSeq: number) => event({ kind: "support.read", readerKind, lastReadSeq });
    expect(applySupportEvent(state({ seenUpToSeq: 1 }), read("agent", 2)!, 0).next.seenUpToSeq).toBe(2);
    expect(applySupportEvent(state({ seenUpToSeq: 2 }), read("agent", 1)!, 0).next.seenUpToSeq).toBe(2);
    expect(applySupportEvent(state({ seenUpToSeq: 1 }), read("user", 2)!, 0).next.seenUpToSeq).toBe(1);
  });

  it("takes a resolve or close", () => {
    const e = event({ kind: "support.status", status: "closed" });
    expect(applySupportEvent(state(), e!, 0).next.status).toBe("closed");
  });
});

describe("what the thread offers is what support accepts", () => {
  it("writes on every status but closed; a resolved thread reopens by writing", () => {
    expect(threadActions("resolved", null).canWrite).toBe(true);
    expect(threadActions("closed", null).canWrite).toBe(false);
  });

  it("rates a resolved or closed thread once", () => {
    expect(threadActions("pending_user", null).canRate).toBe(false);
    expect(threadActions("resolved", null).canRate).toBe(true);
    expect(threadActions("closed", { score: 4, comment: null, ratedAt: "2026-10-04T10:00:00.000Z" }).canRate).toBe(false);
  });

  it("offers reopen on a closed thread only", () => {
    expect(threadActions("closed", null).canReopen).toBe(true);
    expect(threadActions("resolved", null).canReopen).toBe(false);
  });
});

describe("typing is sent, not streamed", () => {
  it("sends once, then not again until the gate's interval has passed", () => {
    const gate = typingGate(4_000);
    expect(gate.shouldSend(0)).toBe(true);
    expect(gate.shouldSend(3_999)).toBe(false);
    expect(gate.shouldSend(4_000)).toBe(true);
    gate.reset();
    expect(gate.shouldSend(4_001)).toBe(true);
  });
});

describe("every value support can answer has a sentence", () => {
  it("covers ConversationStatus and AttachmentScanStatus exactly", () => {
    expect(Object.keys(STATUS_KEYS).sort()).toEqual(enumValues("ConversationStatus").sort());
    expect(Object.keys(SCAN_KEYS).sort()).toEqual(enumValues("AttachmentScanStatus").sort());
  });

  it.each(["fa", "en"])("in %s", (lang) => {
    const common = JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")) as Record<string, unknown>;
    const at = (key: string) => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], common);
    const leaves = (o: unknown): string[] => (typeof o === "string" ? [o] : Object.values(o as object).flatMap(leaves));
    for (const key of leaves(SUPPORT_KEYS)) expect(typeof at(key), key).toBe("string");
  });
});

describe("the menu's Support entry opens the page", () => {
  const USER: Me = {
    userId: "u1",
    fullName: "Theora",
    role: { id: "r1", name: "User" },
    permissions: [],
    tenant: { id: "t-res", type: "reseller", isOwner: false },
    email: null,
    isImpersonated: false,
  };

  it("is linked for any signed-in user", () => {
    expect(menuHrefs(visibleMenu(PANEL_MENU, USER.permissions, USER.tenant.type, USER.tenant.isOwner))).toContain(PANEL_SUPPORT);
  });

  it("puts a thread under the page", () => {
    expect(panelSupportThreadPath("a b")).toBe(`${PANEL_SUPPORT}/a%20b`);
  });
});
