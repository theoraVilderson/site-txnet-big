/**
 * The Node twin of i18n-platform/clients/go/client_test.go, and the same
 * contract: a blocking boot that fails fast rather than serving an empty
 * string table, a cache replaced per language rather than merged, and a
 * lookup that falls back — default language, then the key itself — instead of
 * ever returning empty or throwing. Every Node service depends on those four
 * behaviours, and the two clients are only "identical" for as long as
 * something checks.
 *
 * Run with `npm test` (node:test — no test framework is added to this
 * package). It exercises the shipped `dist/`, which is what services import.
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

import { createLocaleClient } from "./dist/index.js";
import { LOCALE_PROTO } from "./dist/proto.js";

const quiet = { log() {}, warn() {}, error() {} };

// --- a scriptable locale-service ---------------------------------------

function serviceDef() {
  const dir = mkdtempSync(join(tmpdir(), "locale-test-proto-"));
  const file = join(dir, "locale.proto");
  writeFileSync(file, LOCALE_PROTO);
  const pkg = grpc.loadPackageDefinition(
    loadSync(file, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }),
  );
  return pkg.locale.v1.LocaleService.service;
}

function snapshot(lang, version, namespaces) {
  return {
    lang,
    scope: "backend",
    version,
    namespaces: Object.fromEntries(
      Object.entries(namespaces).map(([ns, entries]) => [ns, { entries }]),
    ),
  };
}

/**
 * A locale-service whose answers each test can rewrite, plus a `push` that
 * sends an UpdateEvent to every connected Watch stream.
 */
async function startFakeService({ snapshots = {}, locales = [], failSnapshots = 0 } = {}) {
  const state = { snapshots: { ...snapshots }, locales, failSnapshots, calls: [], watchers: [], watchRequests: [] };

  const server = new grpc.Server();
  server.addService(serviceDef(), {
    GetSnapshot(call, callback) {
      state.calls.push(`GetSnapshot:${call.request.lang}`);
      if (state.failSnapshots > 0) {
        state.failSnapshots -= 1;
        return callback({ code: grpc.status.UNAVAILABLE, message: "not ready" });
      }
      const snap = state.snapshots[call.request.lang];
      if (!snap) return callback({ code: grpc.status.NOT_FOUND, message: "unknown lang" });
      callback(null, snap);
    },
    GetAvailableLocales(_call, callback) {
      state.calls.push("GetAvailableLocales");
      callback(null, { locales: state.locales });
    },
    Watch(call) {
      state.calls.push("Watch");
      state.watchers.push(call);
      state.watchRequests.push(call.request);
      call.on("cancelled", () => {
        state.watchers = state.watchers.filter((w) => w !== call);
      });
    },
  });

  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );

  return {
    addr: `127.0.0.1:${port}`,
    state,
    setSnapshot: (snap) => {
      state.snapshots[snap.lang] = snap;
    },
    push: (event) => {
      for (const w of state.watchers) w.write(event);
    },
    watcherCount: () => state.watchers.length,
    stop: () => new Promise((resolve) => server.tryShutdown(() => resolve())),
  };
}

/** en + fa, one namespace each — the fixture most tests start from. */
function twoLanguages() {
  return {
    locales: [
      { code: "en", name: "English", short_name: "EN", native_name: "English", dir: "ltr", locale: "en-US" },
      { code: "fa", name: "Persian", short_name: "FA", native_name: "فارسی", dir: "rtl", locale: "fa-IR" },
    ],
    snapshots: {
      en: snapshot("en", "v1", {
        errors: { "auth.unauthorized": "Unauthorized", "auth.only_in_en": "English only" },
        messages: { greeting: "Hello {{name}}", spaced: "Hi {{ name }}" },
      }),
      fa: snapshot("fa", "v1", { errors: { "auth.unauthorized": "دسترسی ندارید" } }),
    },
  };
}

async function waitFor(what, cond, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// --- boot ---------------------------------------------------------------

describe("boot", () => {
  let svc;
  before(async () => {
    svc = await startFakeService(twoLanguages());
  });
  after(async () => {
    await svc.stop();
  });

  test("ready() resolves only once every preload language is cached", async () => {
    // A service that starts before its strings are cached serves raw keys to
    // real users for its first seconds.
    const client = createLocaleClient({
      addr: svc.addr,
      scope: "backend",
      preloadLangs: ["en", "fa"],
      logger: quiet,
    });
    await client.ready();

    assert.equal(client.translate("en", "errors", "auth.unauthorized"), "Unauthorized");
    assert.equal(client.translate("fa", "errors", "auth.unauthorized"), "دسترسی ندارید");
    client.close();
  });

  test("an explicit preload list costs no GetAvailableLocales round-trip", async () => {
    svc.state.calls.length = 0;
    const client = createLocaleClient({
      addr: svc.addr,
      scope: "backend",
      preloadLangs: ["en"],
      logger: quiet,
    });
    await client.ready();

    assert.ok(!svc.state.calls.includes("GetAvailableLocales"));
    client.close();
  });

  test("with no preload list it loads every advertised language", async () => {
    const client = createLocaleClient({ addr: svc.addr, scope: "backend", logger: quiet });
    await client.ready();

    assert.deepEqual(client.languages(), ["en", "fa"]);
    assert.equal(client.defaultLang(), "en");
    client.close();
  });

  test("defaultLang falls back to the first preload language", async () => {
    const client = createLocaleClient({
      addr: svc.addr,
      scope: "backend",
      preloadLangs: ["fa", "en"],
      logger: quiet,
    });
    await client.ready();

    assert.equal(client.defaultLang(), "fa");
    // The configured order is a priority order, not just a filter.
    assert.deepEqual(client.languages(), ["fa", "en"]);
    client.close();
  });

  test("ready() is idempotent — a second call does not re-boot", async () => {
    const client = createLocaleClient({
      addr: svc.addr,
      scope: "backend",
      preloadLangs: ["en"],
      logger: quiet,
    });
    await client.ready();
    svc.state.calls.length = 0;
    await client.ready();

    assert.deepEqual(svc.state.calls, []);
    client.close();
  });
});

test("boot retries while locale-service is still starting", async () => {
  const svc = await startFakeService({ ...twoLanguages(), failSnapshots: 2 });
  const client = createLocaleClient({
    addr: svc.addr,
    scope: "backend",
    preloadLangs: ["en"],
    bootTimeoutMs: 10_000,
    logger: quiet,
  });

  await client.ready();
  assert.equal(client.translate("en", "errors", "auth.unauthorized"), "Unauthorized");

  client.close();
  await svc.stop();
});

test("ready() rejects when no snapshot can be fetched", async () => {
  // Failing fast is the point of bootTimeoutMs: a service that started anyway
  // with an empty cache would serve keys instead of text, silently.
  const svc = await startFakeService(); // knows no languages
  const client = createLocaleClient({
    addr: svc.addr,
    scope: "backend",
    preloadLangs: ["en"],
    bootTimeoutMs: 1500,
    logger: quiet,
  });

  await assert.rejects(() => client.ready(), /boot failed/);

  client.close();
  await svc.stop();
});

test("a failed boot is not cached — the next ready() tries again", async () => {
  const svc = await startFakeService();
  const client = createLocaleClient({
    addr: svc.addr,
    scope: "backend",
    preloadLangs: ["en"],
    bootTimeoutMs: 1200,
    logger: quiet,
  });

  await assert.rejects(() => client.ready());
  svc.setSnapshot(snapshot("en", "v1", { errors: { "auth.unauthorized": "Unauthorized" } }));
  await client.ready();

  assert.equal(client.translate("en", "errors", "auth.unauthorized"), "Unauthorized");
  client.close();
  await svc.stop();
});

// --- lookup and fallback -------------------------------------------------

describe("lookup", () => {
  let svc;
  let client;
  before(async () => {
    svc = await startFakeService(twoLanguages());
    client = createLocaleClient({
      addr: svc.addr,
      scope: "backend",
      preloadLangs: ["en", "fa"],
      defaultLang: "en",
      logger: quiet,
    });
    await client.ready();
  });
  after(async () => {
    client.close();
    await svc.stop();
  });

  // The fallback chain is what keeps a half-translated language usable.
  // Returning "" anywhere in it would put blank text in front of a user.
  const fallbackCases = [
    ["present in the asked language", "fa", "errors", "auth.unauthorized", "دسترسی ندارید"],
    ["missing key falls back to the default language", "fa", "errors", "auth.only_in_en", "English only"],
    ["missing namespace falls back too", "fa", "messages", "greeting", "Hello {{name}}"],
    ["missing everywhere returns the key", "fa", "errors", "auth.nowhere", "auth.nowhere"],
    ["missing in the default language returns the key", "en", "errors", "auth.nowhere", "auth.nowhere"],
    ["unknown language falls back to the default", "de", "errors", "auth.unauthorized", "Unauthorized"],
    ["unknown language and unknown key returns the key", "de", "errors", "nope", "nope"],
    ["unknown namespace returns the key", "en", "nope", "auth.unauthorized", "auth.unauthorized"],
  ];

  for (const [name, lang, ns, key, want] of fallbackCases) {
    test(`translate: ${name}`, () => {
      assert.equal(client.translate(lang, ns, key), want);
    });
  }

  const interpolationCases = [
    ["substitutes a variable", "greeting", { name: "Ada" }, "Hello Ada"],
    ["tolerates whitespace inside the braces", "spaced", { name: "Ada" }, "Hi Ada"],
    ["leaves an unsupplied variable in place", "greeting", { other: "x" }, "Hello {{name}}"],
    ["undefined vars is not a crash", "greeting", undefined, "Hello {{name}}"],
    ["an extra variable is ignored", "greeting", { name: "Ada", unused: "y" }, "Hello Ada"],
    ["a numeric value is stringified", "greeting", { name: 7 }, "Hello 7"],
    ["an empty value substitutes as empty", "greeting", { name: "" }, "Hello "],
  ];

  for (const [name, key, vars, want] of interpolationCases) {
    test(`t: ${name}`, () => {
      assert.equal(client.t("en", "messages", key, vars), want);
    });
  }

  test("t: a missing key is returned untouched, not interpolated", () => {
    assert.equal(client.t("en", "messages", "no.such.key", { name: "Ada" }), "no.such.key");
  });

  test("namespace() hands out a copy", () => {
    const entries = client.namespace("en", "errors");
    entries["auth.unauthorized"] = "MUTATED";

    assert.equal(client.translate("en", "errors", "auth.unauthorized"), "Unauthorized");
    assert.equal(client.namespace("en", "nope"), undefined);
    assert.equal(client.namespace("de", "errors"), undefined);
  });

  test("cached() exposes the whole snapshot, version included", () => {
    assert.equal(client.cached("en").version, "v1");
    assert.equal(client.cached("de"), undefined);
  });

  const resolveCases = [
    ["", "en"],
    ["fa", "fa"],
    ["FA", "fa"],
    ["fa-IR", "fa"],
    ["fa-IR,fa;q=0.9,en;q=0.8", "fa"],
    ["de-DE,de;q=0.9,fa;q=0.8", "fa"],
    ["de", "en"],
    ["  fa  ", "fa"],
    [",,fa", "fa"],
    [";q=0.9", "en"],
    [undefined, "en"],
  ];

  for (const [header, want] of resolveCases) {
    test(`resolveLanguage(${JSON.stringify(header)}) -> ${want}`, () => {
      assert.equal(client.resolveLanguage(header), want);
    });
  }
});

// --- the watch stream ----------------------------------------------------

describe("watch", () => {
  let svc;
  let client;
  before(async () => {
    svc = await startFakeService(twoLanguages());
    client = createLocaleClient({
      addr: svc.addr,
      scope: "backend",
      preloadLangs: ["en"],
      logger: quiet,
    });
    await client.ready();
    await waitFor("the watch stream to connect", () => svc.watcherCount() === 1);
  });
  after(async () => {
    client.close();
    await svc.stop();
  });

  test("subscribes to the configured scope and languages", () => {
    const req = svc.state.watchRequests[0];
    assert.equal(req.scope, "backend");
    assert.deepEqual(req.langs, ["en"]);
  });

  test("a pushed snapshot replaces the language rather than merging it", async () => {
    // Merging would leave a deleted key answering forever — a removed string
    // outliving the release that removed it.
    svc.push({
      lang: "en",
      scope: "backend",
      new_version: "v2",
      full_snapshot: snapshot("en", "v2", { errors: { "auth.unauthorized": "Not allowed" } }),
    });

    await waitFor(
      "the pushed snapshot to land",
      () => client.translate("en", "errors", "auth.unauthorized") === "Not allowed",
    );
    assert.equal(client.translate("en", "errors", "auth.only_in_en"), "auth.only_in_en");
    assert.equal(client.namespace("en", "messages"), undefined);
  });

  test("an event with no snapshot is a no-op, not a cache wipe", async () => {
    svc.push({ lang: "en", scope: "backend", new_version: "v3" });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(client.translate("en", "errors", "auth.unauthorized"), "Not allowed");
  });
});

test("resync refetches every preload language", async () => {
  const svc = await startFakeService(twoLanguages());
  const client = createLocaleClient({
    addr: svc.addr,
    scope: "backend",
    preloadLangs: ["en"],
    logger: quiet,
  });
  await client.ready();

  svc.setSnapshot(snapshot("en", "v5", { errors: { "auth.unauthorized": "Resynced" } }));
  await client.resync();

  assert.equal(client.translate("en", "errors", "auth.unauthorized"), "Resynced");
  client.close();
  await svc.stop();
});

test("close() stops the watch stream and lookups still answer from cache", async () => {
  // Shutdown is not an excuse to throw on a request that is already in flight.
  const svc = await startFakeService(twoLanguages());
  const client = createLocaleClient({
    addr: svc.addr,
    scope: "backend",
    preloadLangs: ["en"],
    logger: quiet,
  });
  await client.ready();
  await waitFor("the watch stream to connect", () => svc.watcherCount() === 1);

  client.close();
  await waitFor("the watch stream to go away", () => svc.watcherCount() === 0);

  assert.equal(client.translate("en", "errors", "auth.unauthorized"), "Unauthorized");
  await svc.stop();
});

test("availableLocales and snapshot go to the service, uncached", async () => {
  const svc = await startFakeService(twoLanguages());
  const client = createLocaleClient({
    addr: svc.addr,
    scope: "backend",
    preloadLangs: ["en"],
    logger: quiet,
  });
  await client.ready();

  const locales = await client.availableLocales();
  assert.equal(locales.length, 2);
  assert.equal(locales[1].dir, "rtl");

  // snapshot() is what codegen uses: it must bypass the cache and must not
  // disturb it.
  svc.setSnapshot(snapshot("en", "v9", { errors: { a: "b" } }));
  const fresh = await client.snapshot("en");
  assert.equal(fresh.version, "v9");
  assert.equal(client.translate("en", "errors", "auth.unauthorized"), "Unauthorized");

  client.close();
  await svc.stop();
});

test("snapshot of an unknown language rejects", async () => {
  const svc = await startFakeService(twoLanguages());
  const client = createLocaleClient({
    addr: svc.addr,
    scope: "backend",
    preloadLangs: ["en"],
    logger: quiet,
  });
  await client.ready();

  await assert.rejects(() => client.snapshot("de"));

  client.close();
  await svc.stop();
});
