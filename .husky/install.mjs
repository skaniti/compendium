// Husky install shim (husky docs recipe): local `npm ci` installs the git
// hooks; CI and production builds (Vercel sets CI=1) skip it, and a missing
// husky package (hosts that omit devDependencies) is not an error.
const ci = process.env.CI === "1" || process.env.CI === "true";
if (ci || process.env.NODE_ENV === "production" || process.env.HUSKY === "0") {
  process.exit(0);
}
try {
  const husky = (await import("husky")).default;
  console.log(husky());
} catch {
  console.log("husky: package not installed, skipping hook setup");
}
