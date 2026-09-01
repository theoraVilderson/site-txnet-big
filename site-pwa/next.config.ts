import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["txnet.cyou", "*.txnet.cyou"],
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
