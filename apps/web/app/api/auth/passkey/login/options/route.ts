import { crossOriginRefusal } from "@/lib/cross-origin-guard";
import { needsTailnetResponse, passkeyErrorResponse, passkeyTailnetLogin, postToPasskeyBackend } from "@/lib/passkey-backend";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const refused = crossOriginRefusal(req);
  if (refused) return refused;
  const login = passkeyTailnetLogin(req);
  if (!login) return needsTailnetResponse();
  const result = await postToPasskeyBackend(req, "/api/auth/passkey/login/options", { tailnet_login: login });
  if (!result.ok) return passkeyErrorResponse(result.status, "login");
  return Response.json({ options: result.data.options });
}
