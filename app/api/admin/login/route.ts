import { NextResponse } from "next/server";
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS, createSessionValue, passwordMatches } from "@/lib/adminAuth";
import { clientIp } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

// 盡力而為的登入限流（單一實例記憶體）：每 IP 15 分鐘 10 次
const attempts = new Map<string, number[]>();

const back = (req: Request, err: string) => {
  const u = new URL("/admin/login", req.url);
  u.searchParams.set("err", err);
  return NextResponse.redirect(u, 303);
};

export async function POST(req: Request) {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  if (list.length >= 10) return back(req, "嘗試太多次，請稍後再試");
  list.push(now);
  attempts.set(ip, list);

  const form = await req.formData();
  const pw = form.get("password");
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || typeof pw !== "string" || !(await passwordMatches(pw, process.env.ADMIN_PASSWORD, secret))) {
    return back(req, "密碼錯誤");
  }
  attempts.delete(ip);
  const res = NextResponse.redirect(new URL("/admin", req.url), 303);
  res.cookies.set(ADMIN_COOKIE, await createSessionValue(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return res;
}
