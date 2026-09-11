import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CHANNEL_LABEL, PROOF_LABEL } from "./labels";

/**
 * F-084. The two label families on this screen were keys built at runtime.
 * The exhaustive maps make every member a compile-checked constant; this test
 * says each one has a sentence in every language the panel ships, because a
 * missing translation renders as the raw key and throws nothing.
 */
const LANGS = join(__dirname, "../../../../../../locales/frontend/langs");

function flat(prefix: string, v: unknown, out: Map<string, string>) {
  if (v && typeof v === "object") {
    for (const [k, c] of Object.entries(v)) flat(prefix ? `${prefix}.${k}` : k, c, out);
  } else if (typeof v === "string") out.set(prefix, v);
}

describe.each(["fa", "en"])("add-account labels in %s", (lang) => {
  const common = new Map<string, string>();
  flat("", JSON.parse(readFileSync(join(LANGS, lang, "common.json"), "utf8")), common);

  it.each([...Object.entries(PROOF_LABEL), ...Object.entries(CHANNEL_LABEL)])(
    "%s resolves to a sentence",
    (_member, key) => {
      expect(common.get(key)?.trim()).toBeTruthy();
    },
  );
});
