import { headers } from "next/headers";
import { onPasskeyHost, passkeysEnabled } from "@/lib/passkey-config";
import { tailnetLoginFrom } from "@/lib/tailnet-login";
import EnrollClient from "./EnrollClient";

export const dynamic = "force-dynamic";

// owner-passkeys (spec 4.2): opened from the link `owner_auth.py enroll`
// prints. Usable only with passkeys on, on the relying-party host, from a
// device carrying the owner's tailnet login; the token is in the fragment,
// which only the client can read.
export default async function EnrollPage() {
  const requestHeaders = await headers();
  const ready = passkeysEnabled() && onPasskeyHost(requestHeaders) && tailnetLoginFrom(requestHeaders) !== null;
  return <EnrollClient ready={ready} />;
}
