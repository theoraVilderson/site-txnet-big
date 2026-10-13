// Type-aware lint for the backend (CS-1-j). Deliberately not a preset: each rule
// below is a CONVENTIONS.md rule that a regex could only approximate, so a
// failure here always names a convention, never a taste.
//
// Today's hits live in each project's `eslint-suppressions.json`, a per-file,
// per-rule count. A new hit fails; a fixed one fails too until
// `--prune-suppressions` records it, so the baseline only shrinks
// (docs/CODE-LAYOUT.md "Lint").
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "vendor/**", ".nx/**", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.mts"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    // Off: existing disables name rules this config does not run (no-control-regex,
    // a generator's blanket disable), and would read as "unused". codeshape's
    // `lint-off` smell already holds a disable without a reason.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      // C-24: types are honest.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],
      // C-25: an error is handled once, on purpose.
      "@typescript-eslint/no-floating-promises": "error",
      "no-empty": "error",
    },
  },
);
