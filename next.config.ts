import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Public recipient packet pages. Send no Referer on any navigation away
        // from a packet so the (bearer-token) /p/<slug> URL never leaks to a
        // third-party site the recipient taps through to. Belt-and-suspenders
        // with the per-link rel="noopener noreferrer" already on outbound links.
        source: "/p/:slug*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
