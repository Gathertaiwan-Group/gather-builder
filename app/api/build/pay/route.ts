import { handleBuildPay } from "@/lib/platform/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleBuildPay(req);
