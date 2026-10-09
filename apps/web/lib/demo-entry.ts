// demo-one-click-entry (2026-10-09): the hosted public demo lets a visitor
// in with one click. The Vercel project is the only deployment that sets
// NEXT_PUBLIC_TURNSTILE_SITE_KEY, so its presence is the single switch for
// the Enter button, the entry route and the noindex rules. The owner web
// and local runs never set it and keep the password page.
export const DEMO_ENTRY_ROUTE = "/api/auth/demo";
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

export function turnstileSiteKey(): string {
  return (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();
}

export function demoEntryEnabled(): boolean {
  return turnstileSiteKey().length > 0;
}
