import { handleSlugCheck } from "@/lib/platform/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => handleSlugCheck(req);
