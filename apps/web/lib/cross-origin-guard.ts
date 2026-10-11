// owner-passkeys R12 (2026-10-11): the owner app shares its registrable
// site with the public demo, so SameSite=Lax no longer keeps a demo page
// from making requests that carry the owner's cookies. Every unsafe method
// that reaches the backend or touches a session therefore must come from
// this origin, the same rules as Go's net/http CrossOriginProtection:
// Sec-Fetch-Site same-origin or none passes and any other value is refused
// (same-site is how a request from the demo arrives); without Sec-Fetch-Site,
// an Origin must match the Host, and no Origin at all is a non-browser
// client, which no browser-borne attack can produce.
export const CROSS_ORIGIN_ERROR = "CROSS_ORIGIN";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refuse(req: Request, site: string | null, origin: string | null): Response {
  console.warn(
    `cross-origin refusal: ${req.method} ${new URL(req.url).pathname} ` +
      `sec-fetch-site=${site ?? "-"} origin=${origin ?? "-"}`,
  );
  return Response.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
}

export function crossOriginRefusal(req: Request): Response | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  if (site !== null) {
    return site === "same-origin" || site === "none" ? null : refuse(req, site, origin);
  }
  if (origin === null) return null;
  const host = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
  let originHost: string | null = null;
  try {
    originHost = origin === "null" ? null : new URL(origin).host.toLowerCase();
  } catch {
    originHost = null;
  }
  return originHost !== null && originHost === host ? null : refuse(req, site, origin);
}
