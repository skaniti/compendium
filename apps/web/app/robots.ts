import type { MetadataRoute } from "next";
import { demoEntryEnabled } from "@/lib/demo-entry";

// demo-one-click-entry: the hosted demo tells crawlers to stay out; every
// other deployment (owner web, local) is unaffected.
export default function robots(): MetadataRoute.Robots {
  return demoEntryEnabled()
    ? { rules: { userAgent: "*", disallow: "/" } }
    : { rules: { userAgent: "*", allow: "/" } };
}
