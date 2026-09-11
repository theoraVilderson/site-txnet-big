#!/usr/bin/env -S npx tsx
/**
 * locale-sdk-gen (TypeScript) — emits typed key constants for one locale scope,
 * so a renamed or typo'd key is a compile error instead of a raw key rendered
 * on screen (ADR-0036).
 *
 * Only the *shape* (key names) is generated, never the content — cross-language
 * key parity is `locales/scripts/validate.ts`.
 *
 * Two sources:
 *
 *   --dir <locales root>   read `locales/<scope>/langs/<lang>/*.json` (plus
 *                          `locales/shareds/<lang>/*.json`) straight from disk.
 *                          This is what `make i18n-keys` and CI use. It never
 *                          needs a running locale-service, which is what makes
 *                          it hermetic enough to be a gate. ADR-0003 is
 *                          untouched: the service is the source of truth for
 *                          *serving*; the files say what *exists*.
 *   (no --dir)             ask locale-service over gRPC (LOCALE_SERVICE_ADDR),
 *                          the original ad-hoc path.
 *
 *   npx tsx generate.ts --dir ../../locales --scope backend \
 *     --out ../../txnet-backend/shared-core/src/lib/i18n/keys.backend.generated.ts \
 *     --export BackendI18nKeys --quote single
 *
 * **Two ways this could ship a silent false green, both closed.**
 * - Fail-soft. The gRPC path used to keep stale output when the service was
 *   unreachable. `--dir` never does, and `--strict` turns fail-soft off for the
 *   gRPC path too: a gate that passes because it could not read its input is
 *   worse than no gate.
 * - Nondeterminism. Keys are sorted and the header carries no timestamp and no
 *   snapshot version, so the same `locales/` always produces byte-identical
 *   output and `git diff --exit-code` means something.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const REFERENCE_LANG = arg("lang", "fa"); // project reference language is always fa
const SCOPE = arg("scope", "frontend");
const DIR = arg("dir", "");
const OUT = arg("out", join(process.cwd(), ".generated", "i18n", `keys.${SCOPE}.generated.ts`));
const EXPORT = arg("export", `${SCOPE.charAt(0).toUpperCase()}${SCOPE.slice(1)}I18nKeys`);
const Q = arg("quote", "single") === "double" ? '"' : "'";
const STRICT = flag("strict") || DIR !== "";
/**
 * Emit only these namespaces (comma-separated). For a consumer that reads a
 * *different* scope's vocabulary without importing it whole — the panel
 * receives backend `errors` keys off a socket and cannot import `shared-core`.
 */
const ONLY = arg("only", "").split(",").map((s) => s.trim()).filter(Boolean);

type Flat = Record<string, string>;

/** `{"a":{"b":"x"}}` -> `{"a.b":"x"}` — the same rule as locale-service's store.go. */
function flatten(prefix: string, value: unknown, out: Flat): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, child] of Object.entries(value)) {
      flatten(prefix ? `${prefix}.${k}` : k, child, out);
    }
  } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out[prefix] = String(value);
  }
}

function readLangDir(path: string): Record<string, Flat> {
  const namespaces: Record<string, Flat> = {};
  if (!existsSync(path)) return namespaces;
  for (const name of readdirSync(path).sort()) {
    if (!name.endsWith(".json") || name === "metadata.json") continue;
    const flat: Flat = {};
    flatten("", JSON.parse(readFileSync(join(path, name), "utf8")), flat);
    namespaces[name.slice(0, -".json".length)] = flat;
  }
  return namespaces;
}

/** Shareds first, then the named scope on top — the service's merge order. */
function fromDisk(root: string): Record<string, Flat> {
  const scoped = join(root, SCOPE, "langs", REFERENCE_LANG);
  if (!existsSync(scoped)) {
    throw new Error(`no such locale directory: ${scoped}`);
  }
  return { ...readLangDir(join(root, "shareds", REFERENCE_LANG)), ...readLangDir(scoped) };
}

async function fromService(): Promise<Record<string, Flat>> {
  // Imported lazily so the disk path needs no gRPC dependencies installed.
  const { createLocaleClient } = await import("../../clients/node/client");
  const addr = process.env.LOCALE_SERVICE_ADDR ?? "localhost:50051";
  const client = createLocaleClient({ addr, scope: SCOPE, preloadLangs: [], defaultLang: REFERENCE_LANG });
  try {
    const snapshot = await client.snapshot(REFERENCE_LANG);
    const out: Record<string, Flat> = {};
    for (const [ns, data] of Object.entries(snapshot.namespaces)) out[ns] = { ...data.entries };
    return out;
  } finally {
    client.close();
  }
}

type Tree = { [k: string]: Tree | string };

function toTree(flat: Flat): Tree {
  const root: Tree = {};
  for (const key of Object.keys(flat).sort()) {
    const parts = key.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (typeof next === "string") {
        throw new Error(`key ${key} nests under ${part}, which is already a leaf`);
      }
      node = (node[part] ??= {}) as Tree;
    }
    node[parts[parts.length - 1]] = key;
  }
  return root;
}

const str = (s: string) => Q + s.replace(/\\/g, "\\\\").replace(new RegExp(Q, "g"), `\\${Q}`) + Q;

function render(tree: Tree, indent: string): string {
  return Object.keys(tree)
    .sort()
    .map((k) => {
      const v = tree[k];
      return typeof v === "string"
        ? `${indent}${str(k)}: ${str(v)},`
        : `${indent}${str(k)}: {\n${render(v, indent + "  ")}\n${indent}},`;
    })
    .join("\n");
}

function emit(namespaces: Record<string, Flat>): string {
  const names = Object.keys(namespaces).sort();
  const body = names
    .map((ns) => `  ${str(ns)}: {\n${render(toTree(namespaces[ns]), "    ")}\n  },`)
    .join("\n");
  const total = names.reduce((n, ns) => n + Object.keys(namespaces[ns]).length, 0);
  return [
    `// AUTO-GENERATED by i18n-platform/codegen/ts/generate.ts — do not edit.`,
    `// Regenerate with \`make -C i18n-platform i18n-keys\`; CI fails when this is stale.`,
    `// scope: ${SCOPE}, reference language: ${REFERENCE_LANG}, ${names.length} namespaces, ${total} keys.`,
    `/* eslint-disable */`,
    ``,
    `/**`,
    ` * Every key in the \`${SCOPE}\` scope, by namespace. The leaf value is the key`,
    ` * itself, so \`t(${str(names[0] ?? "ns")}, ${EXPORT}.${names[0] ?? "ns"}.x.y)\` passes`,
    ` * exactly the string it always did — and a renamed key no longer compiles.`,
    ` */`,
    `export const ${EXPORT} = {`,
    body,
    `} as const;`,
    ``,
    `type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];`,
    ``,
    `/** A namespace in the \`${SCOPE}\` scope. */`,
    `export type ${EXPORT}Namespace = keyof typeof ${EXPORT};`,
    ``,
    `/** Any key of one namespace, as the string the translator is called with. */`,
    `export type ${EXPORT}Key<N extends ${EXPORT}Namespace> = Leaves<(typeof ${EXPORT})[N]>;`,
    ``,
  ].join("\n");
}

async function main() {
  let namespaces: Record<string, Flat>;
  try {
    namespaces = DIR ? fromDisk(DIR) : await fromService();
  } catch (err) {
    if (!STRICT && existsSync(OUT)) {
      console.warn(`[locale-sdk-gen] source unreadable; keeping existing ${OUT}. (${err})`);
      return;
    }
    console.error(`[locale-sdk-gen] cannot read the ${SCOPE} scope: ${err}`);
    process.exit(1);
  }
  if (ONLY.length > 0) {
    const missing = ONLY.filter((ns) => !(ns in namespaces));
    if (missing.length > 0) {
      console.error(`[locale-sdk-gen] --only names namespaces the ${SCOPE} scope does not have: ${missing.join(", ")}`);
      process.exit(1);
    }
    namespaces = Object.fromEntries(ONLY.map((ns) => [ns, namespaces[ns]]));
  }
  if (Object.keys(namespaces).length === 0) {
    console.error(`[locale-sdk-gen] the ${SCOPE} scope has no namespaces — refusing to write an empty catalogue`);
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, emit(namespaces));
  console.log(`[locale-sdk-gen] wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
