import { corsPreflight, handleAsMetadata } from "@/lib/oauth/routes";

// RFC 8414 Authorization Server Metadata（issuer＝平台網址，沒有路徑）
export const dynamic = "force-dynamic";
export const GET = (req: Request) => handleAsMetadata(req);
export const OPTIONS = () => corsPreflight();
