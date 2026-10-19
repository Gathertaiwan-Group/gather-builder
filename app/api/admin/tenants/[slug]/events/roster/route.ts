import { NextResponse } from "next/server";
import { backofficeForRequest } from "@/lib/backoffice";
import { exportRegistrationsCsv } from "@/lib/services/events";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

/** 名單 CSV（明文個資）：匯出前已寫入查看紀錄；回應不快取 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const bo = await backofficeForRequest(req, slug);
  // 以店主身分檢視（唯讀）也可以下載，存取已在 backofficeForRequest 寫稽核；匯出本身另寫個資查看紀錄
  if (!bo) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sessionId = new URL(req.url).searchParams.get("session") ?? "";
  try {
    const r = await exportRegistrationsCsv(bo.ctx, { site: slug, sessionId });
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
