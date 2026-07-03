import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["txnet.cyou", "*.txnet.cyou"],
  output: "standalone",

  serverExternalPackages: ["winston", "winston-mongodb"],
};

export default nextConfig;
