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

const nextConfig: NextConfig = {
  allowedDevOrigins: [domainName, `*.${domainName}`],
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
