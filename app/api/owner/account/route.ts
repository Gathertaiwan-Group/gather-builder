import { handleOwnerAccount } from "@/lib/owner/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleOwnerAccount(req);
