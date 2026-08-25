import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Baseline defense-in-depth headers — none of these are a response to a
  // known exploit today (no XSS/injection finding elsewhere in the app),
  // they're the standard floor for a financial app that should hold even if
  // one is found later. Deliberately NOT including Content-Security-Policy
  // here: this app mixes Server Actions, next-intl, and client bundles
  // (recharts, jspdf, exceljs) in ways that likely need real nonce/
  // unsafe-inline testing to get right without breaking something — that's
  // its own follow-up task, not a drop-in header.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Blocks this app from being framed by another origin — closes
          // off clickjacking (an invisible iframe tricking a signed-in user
          // into clicking a real "delete"/"confirm" button underneath).
          { key: "X-Frame-Options", value: "DENY" },
          // Stops the browser from MIME-sniffing a response into an
          // executable type it wasn't served as.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Sends the full referrer only to our own origin; cross-origin
          // requests get just the origin, not the full path/query.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // This app never uses the camera/mic/geolocation — deny outright
          // rather than leaving the default (permissive) policy.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // Forces HTTPS for a full year, including subdomains. Safe even
          // in local dev: browsers only honor HSTS over an actual HTTPS
          // response, so this header is inert over plain HTTP.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

// Links `src/i18n/request.ts` (the default path next-intl looks for) to the
// Next.js build — no custom path needed since that file lives exactly where
// the plugin expects it (`./i18n/request.ts` under `src/`).
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
