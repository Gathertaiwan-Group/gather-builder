import { NextResponse } from "next/server";
import { adminContext, isAdmin } from "@/lib/adminServer";
import { exportRegistrationsCsv } from "@/lib/services/events";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

/** 名單 CSV（明文個資）：匯出前已寫入查看紀錄；回應不快取 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { slug } = await params;
  const sessionId = new URL(req.url).searchParams.get("session") ?? "";
  try {
    const r = await exportRegistrationsCsv(adminContext(req), { site: slug, sessionId });
    return new NextResponse(r.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${r.filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
