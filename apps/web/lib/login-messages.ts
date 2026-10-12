// Task 7a (post-flip-closeout): named constants for the login route's error
// copy, so login/route.ts and the page test share one source of truth
// instead of retyping the strings. Mirrors the "Invalid credentials." copy
// that was already aligned with Dash's _do_login (trailing period).
export const INVALID_CREDENTIALS_MESSAGE = "Invalid credentials.";
export const BACKEND_UNREACHABLE_MESSAGE = "The backend is unreachable; try again shortly.";
export const TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts; wait a minute and try again.";

// demo-one-click-entry: a Turnstile token is single-use and short-lived.
export const CHALLENGE_FAILED_MESSAGE = "The challenge did not pass. Reload and try again.";
export const DEMO_UNAVAILABLE_MESSAGE = "The demo is unavailable right now; try again later.";
export const WIDGET_FAILED_MESSAGE = "The verification check could not load. Reload the page to try again.";

// owner-passkeys (2026-10-11): passkey sign-in and enrollment copy (spec 9).
export const PASSKEY_CANCELLED_MESSAGE = "Passkey sign-in was cancelled.";
export const PASSKEY_SETUP_CANCELLED_MESSAGE = "Passkey setup was cancelled.";
export const NO_PASSKEY_MESSAGE = "No passkey is set up for this account yet. Run the enroll command on the server.";
export const PASSKEY_NEEDS_TAILNET_MESSAGE = "Passkey sign-in works from your tailnet devices.";
export const PASSKEY_FAILED_MESSAGE = "Passkey sign-in didn't work. Try again, or use a break-glass code.";
export const ENROLL_LINK_UNUSABLE_MESSAGE = "This enrollment link can't be used. Run the enroll command again.";
export const PASSKEY_SETUP_FAILED_MESSAGE = "Passkey setup didn't work. Open the enrollment link again to retry.";
