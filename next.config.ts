import type { NextConfig } from "next";

// DEV ONLY. Next 16 blocks cross-origin requests to /_next/* dev resources, so
// opening the dev server from a phone on the same Wi-Fi serves the HTML but not
// the client bundle: the page renders and then sits there, completely inert. It
// looks like broken JavaScript rather than a blocked request, which is what
// makes it worth a comment.
//
// `allowedDevOrigins` has no effect on `next build` / `next start`, so this
// changes nothing in production. Private LAN ranges are listed by pattern so a
// new DHCP lease does not silently reintroduce the problem; add another entry
// (or set FLOWGUIDE_DEV_ORIGINS to a comma-separated list) if you test from a
// network outside these ranges.
const extraDevOrigins = (process.env.FLOWGUIDE_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "192.168.86.147",
    "192.168.*.*",
    "10.*.*.*",
    "172.20.10.*", // iPhone personal hotspot
    ...extraDevOrigins,
  ],
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
