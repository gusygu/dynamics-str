// next.config.mjs
// @ts-check
import { createRequire } from "module";
const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  headers: async () => [
    { source: "/(.*)", headers: [{ key: "x-powered-by", value: "dynamics-matrices" }] },
  ],
  // Append-only: do NOT replace config.plugins or rules
  webpack(config) {
    const hasMini = config.plugins?.some(
      (p) => p && (p.constructor?.name === "MiniCssExtractPlugin" || p.__miniCssExtractPlugin)
    );
    if (!hasMini) {
      const MiniCssExtractPlugin = require("mini-css-extract-plugin");
      config.plugins.push(new MiniCssExtractPlugin({ ignoreOrder: true }));
    }
    return config;
  },
};
export default nextConfig;
