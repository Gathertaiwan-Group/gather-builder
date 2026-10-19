import { corsPreflight, handleRegister } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => handleRegister(req);
export const OPTIONS = () => corsPreflight();
