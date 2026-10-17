import { NextResponse } from "next/server";
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS, createSessionValue, passwordMatches } from "./adminAuth";
import { clientIp } from "./client-ip";
import { hashIp } from "./services/inquiries";
import type { Store } from "./store/types";

// 登入限流：DB 原子計數（跨 serverless 實例有效），每 IP 每 15 分鐘 10 次嘗試
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;

const back = (req: Request, err: string) => {
  const u = new URL("/admin/login", req.url);
  u.searchParams.set("err", err);
  return NextResponse.redirect(u, 303);
};

export async function handleAdminLogin(req: Request, store: Store): Promise<Response> {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return back(req, "後台未設定");
  const hit = await store.rateHit("admin-login", hashIp(clientIp(req), secret), LOGIN_WINDOW_SECONDS, LOGIN_LIMIT);
  if (!hit.allowed) return back(req, "嘗試太多次，請稍後再試");

  const form = await req.formData();
  const pw = form.get("password");
  if (typeof pw !== "string" || !(await passwordMatches(pw, process.env.ADMIN_PASSWORD, secret))) {
    return back(req, "密碼錯誤");
  }
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
