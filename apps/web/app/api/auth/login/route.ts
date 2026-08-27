import { cookies } from "next/headers";
import { applySessionCookies } from "@/lib/session-cookies";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { email: string; password: string };
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Copy aligned with Dash's _do_login (trailing period) -- empty-field
    // validation stays browser-side, this is only the auth-failure string.
    return Response.json({ error: "Invalid credentials." }, { status: res.status });
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    user: { id: number; email: string; name: string };
  };
  applySessionCookies(await cookies(), { accessToken: data.access_token, refreshToken: data.refresh_token });
  return Response.json({ user: data.user });
}
