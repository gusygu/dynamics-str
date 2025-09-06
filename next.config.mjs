/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
  // important: no basePath / assetPrefix / output overrides in dev
  // distDir must remain ".next" in dev so CSS chunks resolve
};

export default nextConfig;
