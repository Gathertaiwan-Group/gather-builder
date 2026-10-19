import { corsPreflight, handleRevoke } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => handleRevoke(req);
export const OPTIONS = () => corsPreflight();
