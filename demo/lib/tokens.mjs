// demo/lib/tokens.mjs -- unsigned-but-structurally-valid JWT minting +
// decode-only parsing for the stub auth suite (Task 5). The frontend's own
// contract (lib/session-cookies.ts's decodeJwtExpiryMs) never verifies a
// signature -- it only reads the 3-part shape and the numeric `exp` claim
// (seconds since epoch) to schedule its own refresh -- so this stub matches
// that exactly rather than implementing real JWT signing. `alg: "none"` in
// the header and a literal "demosig" third segment make the "not a real
// token" nature obvious to anyone inspecting one.

function b64u(o) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

// Monotonic per-process counter folded into a `jti` claim so two tokens
// minted for the same user within the same wall-clock second (iat/exp would
// otherwise be byte-identical, since nothing else in the payload varies)
// are still structurally distinct strings. This matters in practice: login
// immediately followed by refresh/view-as in the same request-response
// cycle is exactly the fast-path a local stub server hits, and callers
// (Task 5's own "refresh rotates both tokens" test) rely on the rotated
// token actually being a NEW string.
let mintCounter = 0;

export function mintToken(user, { actingAsDemo = false, ttlSec = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  mintCounter += 1;
  return [
    b64u({ alg: "none", typ: "JWT" }),
    b64u({
      sub: String(user.id),
      email: user.email,
      role: user.role,
      ...(actingAsDemo && { acting_as_demo: true }),
      iat: now,
      exp: now + ttlSec,
      jti: `${now}-${mintCounter}`,
    }),
    "demosig",
  ].join(".");
}

// Decode-only: no signature check (matches the frontend's own decode
// contract -- see module header). Returns null for anything that isn't a
// well-formed 3-part token with a base64url-JSON middle segment, so callers
// can treat "garbage bearer token" the same as "no token" without a
// try/catch of their own -- per endpoints.md: bearer parsing is decode-only
// and a garbage token must never produce a 401.
export function decodeToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    if (typeof payload !== "object" || payload === null) return null;
    return payload;
  } catch {
    return null;
  }
}

// Extracts the token from an http.IncomingMessage-shaped request's
// Authorization header, if present and well-formed. Case-insensitive on the
// "Bearer" scheme token itself (node lower-cases header NAMES for us, but
// not the scheme value a client sends).
export function bearerFromRequest(req) {
  const header = req.headers?.authorization;
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}
