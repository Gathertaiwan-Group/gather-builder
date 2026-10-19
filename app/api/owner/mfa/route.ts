import { handleOwnerMfa } from "@/lib/owner/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleOwnerMfa(req);
