// Pages that must render with no session. The root layout wraps every page in
// SessionProvider/ThemeProvider, whose mount-time authenticated fetches would
// otherwise 401 and bounce the visitor to /login (lib/api.ts redirectToLogin).
// Exact paths only.
const PRE_AUTH_PATHS: ReadonlySet<string> = new Set(["/login", "/passkey/enroll"]);

export function isPreAuthPath(pathname: string): boolean {
  return PRE_AUTH_PATHS.has(pathname);
}
