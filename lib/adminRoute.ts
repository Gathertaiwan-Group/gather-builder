import { NextResponse } from "next/server";
import { isAdmin, FLASH_COOKIE } from "./adminServer";
import { ServiceError } from "./services/context";

/** 後台表單 POST 的共用處理：驗證 → 執行 → 303 回到頁面並帶結果訊息 */
export async function adminForm(
  req: Request,
  back: string,
  fn: (form: FormData) => Promise<{ message: string; flashToken?: string; redirectTo?: string }>,
): Promise<Response> {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const form = await req.formData();
  const target = (path: string, key: "ok" | "err", msg: string) => {
    const u = new URL(path, req.url);
    u.searchParams.set(key, msg.slice(0, 300));
    return u;
  };
  try {
    const r = await fn(form);
    const res = NextResponse.redirect(target(r.redirectTo ?? back, "ok", r.message), 303);
    if (r.flashToken) {
      // token 原文只顯示一次：放短效 httpOnly cookie，不放網址
      res.cookies.set(FLASH_COOKIE, r.flashToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/admin", maxAge: 120 });
    }
    return res;
  } catch (e) {
    const msg = e instanceof ServiceError ? e.message : "伺服器錯誤";
    if (!(e instanceof ServiceError)) console.error(e);
    return NextResponse.redirect(target(back, "err", msg), 303);
  }
}

export const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

/** 回到來源後台頁（只接受同源 /admin 開頭） */
export function backPath(req: Request, fallback: string): string {
  try {
    const back = new URL(req.headers.get("referer") ?? fallback, req.url);
    return back.origin === new URL(req.url).origin && back.pathname.startsWith("/admin") ? back.pathname : fallback;
  } catch {
    return fallback;
  }
}
