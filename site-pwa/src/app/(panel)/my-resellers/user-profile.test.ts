import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resellerUserPath } from "@/lib/auth-api";
import type { PersonGroup } from "@/lib/auth-api";
import { USER_REFUSAL_KEYS, personGroupLists, profileChanges } from "./_lib/users";

/**
 * The Profile tab on one user's page (AC-1-b) over auth's
 * `GET`/`PATCH …/users/:userId` (AC-1-a). What breaks here with nothing red
 * on the server:
 *
 *  - **a body the schema refuses.** The route is strict and wants at least
 *    one field: an untouched form must send nothing, a field left as it was
 *    must not ride along, and an email is never sent but as `null`;
 *  - **a role offered where it admits nothing.** On a reseller a role is
 *    worth something only with a seat — the Team page's job — so the tab
 *    changes it only for someone already on the team;
 *  - **a refusal with no sentence** — `username_taken` is new.
 */
const REPO = join(__dirname, "../../../../..");
const USERS_CONTROLLER = "txnet-backend/auth-service/src/app/auth/users/reseller-users.controller.ts";

describe("the profile route", () => {
  it("names the reseller and the user in the path, and the controller serves both verbs there", () => {
    expect(resellerUserPath("t-1", "u-1")).toBe("/auth/tenants/t-1/users/u-1");
    expect(resellerUserPath("a b", "c/d")).toBe("/auth/tenants/a%20b/users/c%2Fd");
    const controller = readFileSync(join(REPO, USERS_CONTROLLER), "utf8");
    expect(controller).toContain("@Get(':userId')");
    expect(controller).toContain("@Patch(':userId')");
  });

  it("has a sentence for a username someone else holds", () => {
    expect(USER_REFUSAL_KEYS.username_taken).toBeTruthy();
  });
});

describe("profileChanges", () => {
  const current = { fullName: "Ali Rezaei", username: "ali" };

  it("sends only what changed, trimmed", () => {
    expect(profileChanges(current, { fullName: "  Ali Rezaei ", username: "ali_r" })).toEqual({ username: "ali_r" });
    expect(profileChanges(current, { fullName: "Ali R.", username: "ali" })).toEqual({ fullName: "Ali R." });
  });

  it("sends nothing for an untouched form — the route refuses an empty body", () => {
    expect(profileChanges(current, { fullName: "Ali Rezaei", username: " ali " })).toBeNull();
  });

  it("never clears a username by sending it empty — the route has no such edit", () => {
    expect(profileChanges(current, { fullName: "Ali Rezaei", username: "  " })).toBeNull();
    expect(profileChanges({ fullName: "Ali", username: null }, { fullName: "Ali", username: "" })).toBeNull();
  });
});

describe("personGroupLists", () => {
  const g = (id: string, member: boolean, mayChange: boolean): PersonGroup => ({ id, name: id, member, expiresAt: null, givesKeys: !mayChange, mayChange });

  it("lists the groups they are in, and offers to add only to groups this caller may change", () => {
    const out = personGroupLists([g("vip", true, true), g("admin", false, false), g("support", false, true), g("finance", true, false)]);
    expect(out.member.map((x) => x.id)).toEqual(["vip", "finance"]);
    expect(out.joinable.map((x) => x.id)).toEqual(["support"]);
  });
});
