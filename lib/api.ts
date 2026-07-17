// Thin fetch wrapper: closes the client-side UX loop when the HttpOnly
// access_token cookie is gone/expired. D1 (batch 04 auth/session parity) --
// this is UX only, not a second enforcement layer; the backend's
// verify_api_key is what actually rejects unauthenticated requests. A 401
// here just means "bounce to /login" instead of leaving callers to render a
// blank/broken state against data that will never arrive.
//
// Kept args as a passthrough tuple (not a fixed (input, init) signature) so
// call sites that omit `init` still hit `fetch` with exactly the arguments
// they gave -- callers/tests that assert `fetch` was called with a single
// argument (e.g. lib/preferences.ts's GET) keep working unchanged.
export async function apiFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const res = await fetch(...args);
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.assign("/login");
  }
  return res;
}
