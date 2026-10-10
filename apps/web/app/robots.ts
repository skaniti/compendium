import type { MetadataRoute } from "next";

// demo-one-click-entry: Allow on every deployment, the hosted demo included.
// A Disallow would stop crawlers from fetching the pages, so they would
// never see the noindex response header and meta tag the hosted demo sends
// (next.config.ts headers(), layout generateMetadata); those still apply.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" } };
}
