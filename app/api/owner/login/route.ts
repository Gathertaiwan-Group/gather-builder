import { handleOwnerLogin } from "@/lib/owner/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleOwnerLogin(req);
