import { handleDecision } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => handleDecision(req);
