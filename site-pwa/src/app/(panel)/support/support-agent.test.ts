import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SupportMessage } from "@/lib/support-api";
import { PANEL_SUPPORT_INBOX, PANEL_SUPPORT_SETTINGS, panelSupportInboxThreadPath } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import { applySupportEvent, readSupportEvent, type ThreadState } from "./_lib/support";
import {
  AGENT_KEYS,
  PRIORITY_KEYS,
  VIEW_KEYS,
  agentActions,
  assigneeOf,
  categoryTexts,
  senderNameOf,
  userLinksOf,
  fromHhmm,
  slaFormErrors,
  slaState,
  toHhmm,
} from "./_lib/support-agent";

/**
 * The agent's and admin's side of support (F-033-p) over `/api/support/agent/*`
 * and `/api/support/settings/*`. What breaks with nothing red anywhere:
 *  - **the agent's thread applying a channel message as it came** — the
 *    channel carries the user's view, with no `internal` and no sender
 *    account, so the agent's page must re-read instead;
 *  - **the wrong side's typing or "seen"** — an agent watches the user type
 *    and read, not another agent;
 *  - **a breached SLA shown as fine**, or a stopped clock shown as running;
 *  - **"24:00" lost** — the end of a day is a legal close in the hours editor;
 *  - **an SLA saved that support refuses** — first response after resolution;
 *  - **an action offered that support refuses** — resolve a resolved thread,
 *    anything on a closed one but reading;
 *  - **a priority or inbox view with no sentence**, or a menu entry for staff
 *    shown to a user without the permission.
 */
const REPO = join(__dirname, "../../../../..");
const LOCALES = join(REPO, "locales/frontend/langs");
const PRISMA = readFileSync(join(REPO, "txnet-backend/prisma/domains/support.prisma"), "utf8");
const AGENT_SERVICE = readFileSync(join(REPO, "txnet-backend/support-service/src/app/agent/agent.service.ts"), "utf8");

const CONV = "aaaaaaaa-0000-4000-8000-0000000000d1";
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const msg = (seq: number, over: Partial<SupportMessage> = {}): SupportMessage => ({
  id: `m-${seq}`,
  seq,
  senderKind: "user",
  mine: false,
  body: `body ${seq}`,
  createdAt: "2026-10-04T10:00:00.000Z",
  attachments: [],
  ...over,
});

const thread = (over: Partial<ThreadState> = {}): ThreadState => ({
  conversationId: CONV,
  status: "pending_agent",
  messages: [msg(1)],
  seenUpToSeq: 0,
  peerTypingUntil: 0,
  ...over,
});

const event = (payload: Record<string, unknown>) => readSupportEvent({ conversationId: CONV, ...payload }, CONV)!;

describe("the agent's thread on the channel", () => {
  it("re-reads on a message instead of applying the user's view of it", () => {
    const e = event({ kind: "support.message", status: "pending_agent", message: msg(2) });
    const { next, reread } = applySupportEvent(thread(), e, NOW, "agent");
    expect(reread).toBe(true);
    expect(next.messages.map((m) => m.seq)).toEqual([1]);
    expect(next.status).toBe("pending_agent");
  });

  it("shows the user typing, not another agent", () => {
    const user = event({ kind: "support.typing", senderKind: "user", expiresInMs: 6000 });
    const agent = event({ kind: "support.typing", senderKind: "agent", expiresInMs: 6000 });
    expect(applySupportEvent(thread(), user, NOW, "agent").next.peerTypingUntil).toBe(NOW + 6000);
    expect(applySupportEvent(thread(), agent, NOW, "agent").next.peerTypingUntil).toBe(0);
  });

  it("moves 'seen' on the user's read, not on another agent's", () => {
    expect(applySupportEvent(thread(), event({ kind: "support.read", readerKind: "user", lastReadSeq: 1 }), NOW, "agent").next.seenUpToSeq).toBe(1);
    expect(applySupportEvent(thread(), event({ kind: "support.read", readerKind: "agent", lastReadSeq: 1 }), NOW, "agent").next.seenUpToSeq).toBe(0);
  });
});

describe("the SLA badge", () => {
  const sla = (over: Record<string, unknown> = {}) => ({
    firstResponseDueAt: at(60),
    resolutionDueAt: at(600),
    dueAt: at(60),
    firstResponseBreached: false,
    resolutionBreached: false,
    ...over,
  });

  it("is breached when support says so, or when the running clock is past", () => {
    expect(slaState(sla({ firstResponseBreached: true }), NOW)).toBe("breached");
    expect(slaState(sla({ resolutionBreached: true, dueAt: null }), NOW)).toBe("breached");
    expect(slaState(sla({ dueAt: at(-1) }), NOW)).toBe("breached");
  });

  it("is due soon within 30 minutes, running beyond, stopped with no clock", () => {
    expect(slaState(sla({ dueAt: at(30) }), NOW)).toBe("soon");
    expect(slaState(sla({ dueAt: at(31) }), NOW)).toBe("running");
    expect(slaState(sla({ dueAt: null }), NOW)).toBe("stopped");
  });
});

describe("what the agent is offered is what support accepts", () => {
  const me = "u-me";
  it("takes a thread assigned to someone else or no one, and releases only its own", () => {
    expect(agentActions({ status: "open", assignedToUserId: null }, me)).toMatchObject({ canTake: true, canRelease: false });
    expect(agentActions({ status: "open", assignedToUserId: "u-other" }, me)).toMatchObject({ canTake: true, canRelease: false });
    expect(agentActions({ status: "open", assignedToUserId: me }, me)).toMatchObject({ canTake: false, canRelease: true });
  });

  it("resolves an unfinished thread only, and closes anything not closed", () => {
    expect(agentActions({ status: "pending_user", assignedToUserId: null }, me)).toMatchObject({ canResolve: true, canClose: true, canWrite: true });
    expect(agentActions({ status: "resolved", assignedToUserId: null }, me)).toMatchObject({ canResolve: false, canClose: true, canWrite: true });
    expect(agentActions({ status: "closed", assignedToUserId: me }, me)).toEqual({
      canTake: false,
      canRelease: false,
      canResolve: false,
      canClose: false,
      canWrite: false,
      canPrioritize: false,
    });
  });
});

describe("the settings forms send what support accepts", () => {
  it("reads and writes HH:MM, end of day included", () => {
    expect(toHhmm(0)).toBe("00:00");
    expect(toHhmm(9 * 60 + 5)).toBe("09:05");
    expect(toHhmm(1440)).toBe("24:00");
    expect(fromHhmm("24:00")).toBe(1440);
    expect(fromHhmm("09:30")).toBe(570);
    expect(fromHhmm("24:01")).toBeNull();
    expect(fromHhmm("9:3")).toBeNull();
  });

  it("names every priority whose targets support would refuse", () => {
    expect(
      slaFormErrors([
        { priority: "urgent", firstResponseMinutes: 30, resolutionMinutes: 240 },
        { priority: "high", firstResponseMinutes: 500, resolutionMinutes: 480 },
        { priority: "normal", firstResponseMinutes: 0, resolutionMinutes: 10 },
        { priority: "low", firstResponseMinutes: 10, resolutionMinutes: 43_201 },
      ]),
    ).toEqual(["high", "normal", "low"]);
  });

  it("sends a category's names trimmed, dropping a language left empty", () => {
    expect(categoryTexts({ fa: "  اتصال ", en: "  " })).toEqual([{ lang: "fa", name: "اتصال" }]);
  });
});

describe("every value support can answer has a sentence", () => {
  const enumValues = (name: string) =>
    (PRISMA.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))?.[1] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z_]+$/.test(l));

  it("covers ConversationPriority and the inbox views exactly", () => {
    expect(Object.keys(PRIORITY_KEYS).sort()).toEqual(enumValues("ConversationPriority").sort());
    const views = JSON.parse((AGENT_SERVICE.match(/INBOX_VIEWS = (\[[^\]]*\])/)?.[1] ?? "[]").replace(/'/g, '"')) as string[];
    expect(Object.keys(VIEW_KEYS).sort()).toEqual(views.sort());
  });

  it.each(["fa", "en"])("in %s", (lang) => {
    const common = JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")) as Record<string, unknown>;
    const lookup = (key: string) => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], common);
    const leaves = (o: unknown): string[] => (typeof o === "string" ? [o] : Object.values(o as object).flatMap(leaves));
    for (const key of leaves(AGENT_KEYS)) expect(typeof lookup(key), key).toBe("string");
  });
});

describe("the menu shows the staff pages to staff only", () => {
  const hrefs = (permissions: string[]) => menuHrefs(visibleMenu(PANEL_MENU, permissions, "reseller", false));

  it("needs support.agent for the inbox and support.manage for the settings", () => {
    expect(hrefs([])).not.toContain(PANEL_SUPPORT_INBOX);
    expect(hrefs([])).not.toContain(PANEL_SUPPORT_SETTINGS);
    expect(hrefs(["support.agent"])).toContain(PANEL_SUPPORT_INBOX);
    expect(hrefs(["support.agent"])).not.toContain(PANEL_SUPPORT_SETTINGS);
    expect(hrefs(["support.manage"])).toContain(PANEL_SUPPORT_SETTINGS);
  });

  it("puts an agent's thread under the inbox", () => {
    expect(panelSupportInboxThreadPath("a b")).toBe(`${PANEL_SUPPORT_INBOX}/a%20b`);
  });
});

/**
 * F-033-r: who answered is said by name, and the agent reaches the person and
 * the service the ticket is about in one click. What breaks with nothing red:
 * a name shown on the user's own message, an "assigned to someone else" with
 * the name right there, or a sidebar link to an address the users page does
 * not read.
 */
describe("names and links on a ticket (F-033-r)", () => {
  const msg = (over: Partial<SupportMessage>): SupportMessage => ({ id: "m", seq: 1, senderKind: "agent", mine: false, senderName: null, body: "", createdAt: "", attachments: [], ...over });

  it("names an agent's message, and no one else's", () => {
    expect(senderNameOf(msg({ senderName: "Sara Ahmadi" }))).toBe("Sara Ahmadi");
    expect(senderNameOf(msg({ senderName: null }))).toBeNull();
    expect(senderNameOf(msg({ senderKind: "user", senderName: "x" }))).toBeNull();
    // An older answer without the field reads as no name.
    expect(senderNameOf({ ...msg({}), senderName: undefined } as unknown as SupportMessage)).toBeNull();
  });

  it("says who has the conversation: nobody, me, or the colleague by name", () => {
    expect(assigneeOf({ assignedToUserId: null, assignedToName: null }, "me")).toEqual({ key: "unassigned" });
    expect(assigneeOf({ assignedToUserId: "me", assignedToName: "Me Myself" }, "me")).toEqual({ key: "assignedToMe" });
    expect(assigneeOf({ assignedToUserId: "u-2", assignedToName: "Sara Ahmadi" }, "me")).toEqual({ key: "assignedOther", name: "Sara Ahmadi" });
    expect(assigneeOf({ assignedToUserId: "u-2", assignedToName: null }, "me")).toEqual({ key: "assignedOther" });
  });

  it("links the person's page and one service on it, as the users page reads them", () => {
    const links = userLinksOf("u 1");
    expect(links.page).toBe("/users/u%201");
    expect(links.grant("g-9")).toBe("/users/u%201?grant=g-9");
  });
});
