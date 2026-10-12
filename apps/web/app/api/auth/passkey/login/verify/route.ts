import { crossOriginRefusal } from "@/lib/cross-origin-guard";
import {
  finishPasskeySignIn,
  needsTailnetResponse,
  passkeyErrorResponse,
  passkeyTailnetLogin,
  postToPasskeyBackend,
  readJson,
} from "@/lib/passkey-backend";
import { PASSKEY_FAILED_MESSAGE } from "@/lib/login-messages";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const refused = crossOriginRefusal(req);
  if (refused) return refused;
  const login = passkeyTailnetLogin(req);
  if (!login) return needsTailnetResponse();
  const body = await readJson(req);
  if (!body || typeof body.response !== "object" || body.response === null) {
    return Response.json({ error: PASSKEY_FAILED_MESSAGE }, { status: 400 });
  }
  const result = await postToPasskeyBackend(req, "/api/auth/passkey/login/verify", {
    tailnet_login: login,
    response: body.response,
    trust_browser: body.trustBrowser === true,
  });
  if (!result.ok) return passkeyErrorResponse(result.status, "login");
  return finishPasskeySignIn(result.data);
}
