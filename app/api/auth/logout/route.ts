import { cookies } from "next/headers";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  (await cookies()).delete("access_token");
  return Response.json({ ok: true });
}
