// Task 7a (post-flip-closeout): named constants for the login route's error
// copy, so login/route.ts and the page test share one source of truth
// instead of retyping the strings. Mirrors the "Invalid credentials." copy
// that was already aligned with Dash's _do_login (trailing period).
export const INVALID_CREDENTIALS_MESSAGE = "Invalid credentials.";
export const BACKEND_UNREACHABLE_MESSAGE = "The backend is unreachable; try again shortly.";
export const TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts; wait a minute and try again.";

// demo-one-click-entry: a Turnstile token is single-use and short-lived.
export const CHALLENGE_FAILED_MESSAGE = "The challenge did not pass. Reload and try again.";
