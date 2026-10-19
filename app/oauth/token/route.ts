import { corsPreflight, handleToken } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => handleToken(req);
export const OPTIONS = () => corsPreflight();
