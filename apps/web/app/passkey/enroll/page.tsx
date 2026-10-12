import { cookies, headers } from "next/headers";
import { onPasskeyHost, passkeysEnabled } from "@/lib/passkey-config";
import { TRUSTED_BROWSER_COOKIE, tailnetLoginFrom } from "@/lib/tailnet-login";
import EnrollClient from "./EnrollClient";

export const dynamic = "force-dynamic";

// owner-passkeys (spec 4.2): opened from the link `owner_auth.py enroll`
// prints. Usable only with passkeys on, on the relying-party host, from a
// device carrying the owner's tailnet login; the token is in the fragment,
// which only the client can read.
export default async function EnrollPage() {
  const requestHeaders = await headers();
  const login = tailnetLoginFrom(requestHeaders);
  const ready = passkeysEnabled() && onPasskeyHost(requestHeaders) && login !== null;
  // An already-trusted browser must not mint a second trusted-browser row.
  const trusted = login !== null && !!(await cookies()).get(TRUSTED_BROWSER_COOKIE)?.value;
  return <EnrollClient ready={ready} trusted={trusted} />;
}
