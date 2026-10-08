import type { NextConfig } from "next";

/**
 * The origins Next accepts dev requests from (F-088).
 *
 * `txnet.cyou` was hardcoded here, in the one config file every build of this
 * app reads, though `DOMAIN_NAME` has always existed in `.env` and
 * `src/env.ts` calls itself the single source of truth for the environment.
 * A deployment on any other domain silently got dev-origin warnings it could
 * not turn off without editing the repo.
 *
 * Read straight from `process.env` rather than through `src/env.ts`: this file
 * is evaluated by the Next CLI before the app's module graph exists, so the
 * validated accessor is not available yet. The fallback keeps an unconfigured
 * checkout working exactly as it did.
 */
const domainName = process.env.DOMAIN_NAME?.trim() || "txnet.cyou";

/**
 * A reseller's own domain (`panel.barghgho.ir`) is not under `domainName`, so
 * Next refused its dev requests — the HMR socket among them, which Traefik
 * then reported as a 500. Next has no "any origin" pattern (`**` is refused),
 * so the dev stack names those hosts here, comma-separated. A new one needs a
 * restart, like every value in this file. Dev only: a build serves no HMR.
 */
const extraDevOrigins = (process.env.DEV_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: [domainName, `*.${domainName}`, ...extraDevOrigins],
  output: "standalone",

  serverExternalPackages: [
    "@txnet/locale-client",
    "winston",
    "winston-mongodb",
    "@grpc/grpc-js",
    "@grpc/proto-loader",
  ],
};

export default nextConfig;
