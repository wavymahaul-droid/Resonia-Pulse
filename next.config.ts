import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep every page and endpoint out of search engines, including in public mode.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
