import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { bookingIcs, managedBooking } from "@/lib/services/booking";
import { baseUrlFrom } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** 預約的 .ics（簽章連結才拿得到） */
export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const store = getStore();
  const tenant = await store.getTenantBySlug((await params).site.toLowerCase());
  if (!tenant) return new NextResponse("not found", { status: 404 });
  const u = new URL(req.url);
  const m = await managedBooking(store, tenant, u.searchParams.get("b"), u.searchParams.get("t"));
  if (!m) return new NextResponse("not found", { status: 404 });
  const ics = await bookingIcs(store, tenant, m.booking, m.service, baseUrlFrom(req), !["held", "confirmed"].includes(m.booking.status));
  return new NextResponse(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="booking.ics"', "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
