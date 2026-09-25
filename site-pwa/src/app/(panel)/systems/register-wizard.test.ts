import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DRIVER_TYPES, SYSTEMS_KEYS, emptyRegisterForm, validateRegister } from "./_lib/systems";
import {
  DRIVER_PROFILES,
  REGISTER_STEPS,
  applyDriver,
  composeLogin,
  emptyLoginParts,
  firstInvalidRegisterStep,
  ipOfUrl,
  registerStepErrors,
  type LoginParts,
} from "./_lib/register-wizard";

/**
 * The register-a-panel wizard (F-027-bq). The screens are a walk through the
 * same `RegisterForm` `validateRegister` checks and serialises; what has to
 * hold here:
 *
 * - **A step blocks only on its own fields.** "Next" on the family step must
 *   not complain about a login the operator has not reached yet.
 * - **A family fills what it is** (transport, counting) — what
 *   `contract.drivers.md` says each is — and only families `internal/opener`
 *   can open are offered as ready: the rest register and stay `unopenable`.
 * - **The login is composed, never typed as `user:pass`.** The Opener splits at
 *   the first colon, so a username with one would be tested as someone else.
 */

const REPO = join(__dirname, "../../../../..");
const W = SYSTEMS_KEYS.register.wizard;

const ready = (driver: (typeof DRIVER_TYPES)[number], login: Partial<LoginParts> = {}) => {
  const parts = { ...emptyLoginParts(), username: "admin", password: "p:ss word", apiKey: "k", ...login };
  const form = {
    ...applyDriver(emptyRegisterForm(), driver),
    name: "DE-1",
    region: "de",
    ipAddress: "203.0.113.7",
    apiBaseUrl: "https://de1.example.com:8000",
    radiusSecret: "s3cret",
  };
  return { form: { ...form, credentials: composeLogin(DRIVER_PROFILES[driver].login, parts) }, parts };
};

describe("register wizard steps", () => {
  it("names five steps, login before review", () => {
    expect(REGISTER_STEPS.map((s) => s.id)).toEqual(["family", "details", "connection", "login", "review"]);
  });

  it("covers every field of the form exactly once", () => {
    const fields = REGISTER_STEPS.flatMap((s) => s.fields).sort();
    expect(fields).toEqual(Object.keys(emptyRegisterForm()).sort());
  });

  it("blocks a step only on its own fields", () => {
    const form = emptyRegisterForm();
    const parts = emptyLoginParts();
    expect(registerStepErrors(form, parts, "family")).toEqual({});
    expect(Object.keys(registerStepErrors(form, parts, "details")).sort()).toEqual(["name", "region"]);
    expect(registerStepErrors(form, parts, "details").ipAddress).toBeUndefined();
    // A pull panel is reached at its address alone; only a push panel's NAS needs an IP (F-027-br).
    expect(Object.keys(registerStepErrors(form, parts, "connection")).sort()).toEqual(["apiBaseUrl"]);
    const push = applyDriver(form, "mikrotik_user_manager");
    expect(Object.keys(registerStepErrors(push, parts, "connection"))).toEqual(["ipAddress"]);
  });

  it("finds the first step with an error, for the review step's submit", () => {
    const { form, parts } = ready("marzban");
    expect(firstInvalidRegisterStep(form, parts)).toBeNull();
    expect(validateRegister(form).ok).toBe(true);
    expect(firstInvalidRegisterStep({ ...form, apiBaseUrl: "nope" }, parts)).toBe("connection");
    expect(firstInvalidRegisterStep({ ...form, ipAddress: "" }, parts)).toBeNull();
    expect(firstInvalidRegisterStep({ ...form, name: " " }, parts)).toBe("details");
  });
});

describe("a family fills what it is", () => {
  it("has one profile per driver type", () => {
    expect(Object.keys(DRIVER_PROFILES).sort()).toEqual([...DRIVER_TYPES].sort());
  });

  it("sets transport and counting from the family", () => {
    const um = applyDriver(emptyRegisterForm(), "mikrotik_user_manager");
    expect(um.transport).toBe("push");
    expect(um.counterSemantics).toBe("session");
    const hiddify = applyDriver(um, "hiddify");
    expect(hiddify.transport).toBe("pull");
    expect(hiddify.counterSemantics).toBe("cumulative");
    expect(hiddify.driverType).toBe("hiddify");
  });

  it("keeps what the operator typed when the family changes", () => {
    const typed = { ...emptyRegisterForm(), name: "DE-1", apiBaseUrl: "https://x.example" };
    const next = applyDriver(typed, "sanaee");
    expect(next.name).toBe("DE-1");
    expect(next.apiBaseUrl).toBe("https://x.example");
    // A client address is hidden for a family that has none, so it is never sent from there.
    const withClient = { ...applyDriver(typed, "hiddify"), clientBaseUrl: "https://sub.example" };
    expect(applyDriver(withClient, "marzneshin").clientBaseUrl).toBe("https://sub.example");
    expect(applyDriver(withClient, "marzban").clientBaseUrl).toBe("");
  });

  it("offers as ready exactly the families internal/opener can open", () => {
    const opener = readFileSync(join(REPO, "network-service/internal/opener/opener.go"), "utf8");
    const declaration = readFileSync(join(REPO, "network-service/internal/driver/declaration.go"), "utf8");
    const cases = /func \(o Opener\) Open[\s\S]*?case ([^:]+):/.exec(opener);
    if (!cases) throw new Error("Opener.Open's family case is gone — this test is stale");
    const value = (name: string) => {
      const m = new RegExp(`${name}\\s+DriverType = "([a-z_]+)"`).exec(declaration);
      if (!m) throw new Error(`${name} is gone from declaration.go — this test is stale`);
      return m[1];
    };
    const openable = cases[1].split(",").map((c) => value(c.trim().replace(/^driver\./, "")));
    const offered = DRIVER_TYPES.filter((d) => DRIVER_PROFILES[d].supported);
    expect([...offered].sort()).toEqual(openable.sort());
  });

  it("asks Hiddify for its API key alone and every other family for a username and password", () => {
    expect(DRIVER_PROFILES.hiddify.login).toBe("apiKey");
    for (const d of DRIVER_TYPES.filter((x) => x !== "hiddify")) expect(DRIVER_PROFILES[d].login).toBe("userPassword");
  });

  it("offers a client address only to the families that serve links apart from their API", () => {
    expect(DRIVER_TYPES.filter((d) => DRIVER_PROFILES[d].clientBaseUrl).sort()).toEqual(["hiddify", "marzneshin"]);
  });
});

describe("the login", () => {
  it("is composed as username:password, split at the first colon by the Opener", () => {
    expect(composeLogin("userPassword", { ...emptyLoginParts(), username: "admin", password: "a:b " })).toBe("admin:a:b ");
    expect(composeLogin("apiKey", { ...emptyLoginParts(), apiKey: "0f1e-uuid" })).toBe("0f1e-uuid");
  });

  it("refuses a username with a colon, and either half missing", () => {
    const { form } = ready("marzban");
    const errors = (parts: Partial<LoginParts>) =>
      registerStepErrors(form, { ...emptyLoginParts(), username: "admin", password: "x", ...parts }, "login");
    expect(errors({})).toEqual({});
    expect(errors({ username: "ad:min" }).username).toBe(W.invalid.usernameColon);
    expect(errors({ username: "" }).username).toBe(W.invalid.username);
    expect(errors({ password: "" }).password).toBe(W.invalid.password);
  });

  it("asks a Hiddify panel for its key, not a username", () => {
    const { form } = ready("hiddify");
    expect(registerStepErrors(form, emptyLoginParts(), "login")).toEqual({ apiKey: W.invalid.apiKey });
    expect(registerStepErrors(form, { ...emptyLoginParts(), apiKey: "k" }, "login")).toEqual({});
  });

  it("asks a push panel for its RADIUS secret on the login step", () => {
    const { form, parts } = ready("mikrotik_user_manager");
    expect(registerStepErrors({ ...form, radiusSecret: "" }, parts, "login").radiusSecret).toBe(SYSTEMS_KEYS.register.invalid.radiusSecret);
  });
});

describe("the IP the API address already names", () => {
  it("reads an IP literal out of the address, and nothing out of a hostname", () => {
    expect(ipOfUrl("https://203.0.113.7:2053/panel")).toBe("203.0.113.7");
    expect(ipOfUrl("http://[2001:db8::1]:8000")).toBe("2001:db8::1");
    expect(ipOfUrl("https://de1.example.com")).toBeNull();
    expect(ipOfUrl("not a url")).toBeNull();
  });
});
