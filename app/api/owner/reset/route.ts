import { handleOwnerReset } from "@/lib/owner/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleOwnerReset(req);
