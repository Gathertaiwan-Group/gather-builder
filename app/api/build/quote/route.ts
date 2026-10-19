import { handleQuote } from "@/lib/platform/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleQuote(req);
