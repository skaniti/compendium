import { cookies } from "next/headers";

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
    return Response.json({ error: "Invalid credentials" }, { status: res.status });
  }
  const data = (await res.json()) as { access_token: string; user: { id: number; email: string; name: string } };
  (await cookies()).set("access_token", data.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return Response.json({ user: data.user });
}
