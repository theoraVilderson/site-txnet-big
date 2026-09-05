// eslint-config-next 16 ships flat config directly; FlatCompat cannot consume
// it (it throws "Converting circular structure to JSON" while validating the
// legacy schema), so the shareable configs are spread in as-is.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default eslintConfig;
