import { crossOriginRefusal } from "@/lib/cross-origin-guard";
import {
  needsTailnetResponse,
  passkeyErrorResponse,
  passkeyTailnetLogin,
  postToPasskeyBackend,
  readJson,
} from "@/lib/passkey-backend";
import { ENROLL_LINK_UNUSABLE_MESSAGE } from "@/lib/login-messages";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const refused = crossOriginRefusal(req);
  if (refused) return refused;
  const login = passkeyTailnetLogin(req);
  if (!login) return needsTailnetResponse();
  const body = await readJson(req);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token || token.length > 200) return Response.json({ error: ENROLL_LINK_UNUSABLE_MESSAGE }, { status: 410 });
  const result = await postToPasskeyBackend(req, "/api/auth/passkey/enroll/options", {
    tailnet_login: login,
    enrollment_token: token,
  });
  if (!result.ok) return passkeyErrorResponse(result.status, "enroll");
  return Response.json({ options: result.data.options });
}
