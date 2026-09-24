import {
  COUNTER_SEMANTICS,
  DRIVER_TYPES,
  PANEL_TRANSPORTS,
  SYSTEMS_KEYS,
  validateRegister,
  type RegisterForm,
} from "./systems";

/**
 * The register-a-panel wizard (F-027-bq): the same {@link RegisterForm} the
 * form sent, walked one concern at a time. `validateRegister` stays the only
 * rule for what billing is sent; the one thing added here is the login, asked
 * in its parts and composed the way `internal/opener` reads it.
 */

const W = SYSTEMS_KEYS.register.wizard;

type DriverType = (typeof DRIVER_TYPES)[number];

export type RegisterStepId = "family" | "details" | "connection" | "login" | "review";

export const REGISTER_STEPS: readonly { id: RegisterStepId; fields: readonly (keyof RegisterForm)[] }[] = [
  { id: "family", fields: ["driverType"] },
  { id: "details", fields: ["name", "region", "role"] },
  { id: "connection", fields: ["apiBaseUrl", "clientBaseUrl", "ipAddress", "transport", "counterSemantics", "maxRequestsPerMinute"] },
  { id: "login", fields: ["credentials", "radiusSecret"] },
  { id: "review", fields: [] },
];

/** `username:password` for every family but Hiddify, whose login is its admin API key (`contract.registration.md` rule 2). */
export type LoginKind = "userPassword" | "apiKey";

export type FamilyGroup = "xray" | "router" | "test";

export type DriverProfile = {
  group: FamilyGroup;
  transport: (typeof PANEL_TRANSPORTS)[number];
  counterSemantics: (typeof COUNTER_SEMANTICS)[number];
  login: LoginKind;
  /** Serves its users' links apart from its API (`contract.registration.md` rule 4). */
  clientBaseUrl: boolean;
  /** `internal/opener` has a case for it. Any other family registers and stays `pending` as `unopenable`. */
  supported: boolean;
};

const pull = (group: FamilyGroup, supported: boolean, extra: Partial<DriverProfile> = {}): DriverProfile => ({
  group,
  transport: "pull",
  counterSemantics: "cumulative",
  login: "userPassword",
  clientBaseUrl: false,
  supported,
  ...extra,
});

/**
 * What each family is, as `contract.drivers.md`, `contract.xui.md`,
 * `contract.hiddify.md` and `contract.marzneshin.md` say. A family with no
 * driver yet gets the form's defaults and claims nothing: the operator sets it
 * under "advanced", and the connection test checks it either way.
 */
export const DRIVER_PROFILES: Record<DriverType, DriverProfile> = {
  marzban: pull("xray", true),
  marzneshin: pull("xray", true, { clientBaseUrl: true }),
  sanaee: pull("xray", true),
  three_x_ui: pull("xray", true),
  x_ui_alireza: pull("xray", true),
  x_ui_vaxilu: pull("xray", false),
  hiddify: pull("xray", true, { login: "apiKey", clientBaseUrl: true }),
  s_ui: pull("xray", false),
  core_xray: pull("xray", false),
  mikrotik_user_manager: pull("router", true, { transport: "push", counterSemantics: "session" }),
  mikrotik_wireguard: pull("router", false),
  ibsng: pull("router", false),
  cloudius: pull("router", false),
  fake: pull("test", false),
};

export const FAMILY_GROUPS: readonly FamilyGroup[] = ["xray", "router", "test"];

/**
 * Pick a family: its transport and counting follow it, and a client address it
 * has no use for is cleared, since a field the wizard hides is never sent.
 * Everything the operator typed otherwise is kept.
 */
export function applyDriver(form: RegisterForm, driver: DriverType): RegisterForm {
  const p = DRIVER_PROFILES[driver];
  return {
    ...form,
    driverType: driver,
    transport: p.transport,
    counterSemantics: p.counterSemantics,
    clientBaseUrl: p.clientBaseUrl ? form.clientBaseUrl : "",
  };
}

export type LoginParts = { username: string; password: string; apiKey: string };

export function emptyLoginParts(): LoginParts {
  return { username: "", password: "", apiKey: "" };
}

/** The login as the Opener reads it. Never trimmed: a password may start or end with a space. */
export function composeLogin(kind: LoginKind, parts: LoginParts): string {
  return kind === "apiKey" ? parts.apiKey : `${parts.username}:${parts.password}`;
}

export type WizardErrors = Partial<Record<keyof RegisterForm | keyof LoginParts, string>>;

function loginErrors(kind: LoginKind, parts: LoginParts): WizardErrors {
  const out: WizardErrors = {};
  if (kind === "apiKey") {
    if (!parts.apiKey) out.apiKey = W.invalid.apiKey;
    return out;
  }
  // The Opener splits at the first colon: `ad:min` would be tested as user `ad`.
  if (!parts.username) out.username = W.invalid.username;
  else if (parts.username.includes(":")) out.username = W.invalid.usernameColon;
  if (!parts.password) out.password = W.invalid.password;
  return out;
}

export function registerStepErrors(form: RegisterForm, parts: LoginParts, step: RegisterStepId): WizardErrors {
  const checked = validateRegister(form);
  const all: WizardErrors = checked.ok ? {} : { ...checked.errors };
  const fields = REGISTER_STEPS.find((s) => s.id === step)?.fields ?? [];
  const out: WizardErrors = {};
  for (const k of fields) if (all[k]) out[k] = all[k];
  if (step === "login") {
    const parts_ = loginErrors(DRIVER_PROFILES[form.driverType].login, parts);
    // A missing half says which half; the composed login's own limit only when both are there.
    if (Object.keys(parts_).length > 0) {
      delete out.credentials;
      Object.assign(out, parts_);
    }
  }
  return out;
}

export function firstInvalidRegisterStep(form: RegisterForm, parts: LoginParts): RegisterStepId | null {
  for (const s of REGISTER_STEPS) if (Object.keys(registerStepErrors(form, parts, s.id)).length > 0) return s.id;
  return null;
}

/** The IP an API address already names, to offer for the IP field; null for a hostname. */
export function ipOfUrl(value: string): string | null {
  let host: string;
  try {
    host = new URL(value.trim()).hostname;
  } catch {
    return null;
  }
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
}
