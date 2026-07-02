import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["mytxnet.ir", "*.mytxnet.ir"],
  output: "standalone",

  serverExternalPackages: ["winston", "winston-mongodb"],
};

export default nextConfig;
