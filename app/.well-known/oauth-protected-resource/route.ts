import { corsPreflight, handlePrm } from "@/lib/oauth/routes";

// RFC 9728 Protected Resource Metadata（根路徑）
export const dynamic = "force-dynamic";
export const GET = (req: Request) => handlePrm(req);
export const OPTIONS = () => corsPreflight();
