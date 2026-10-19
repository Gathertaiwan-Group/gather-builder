import { corsPreflight, handlePrm } from "@/lib/oauth/routes";

// RFC 9728 Protected Resource Metadata（MCP 端點 /api/mcp 的路徑插入版本；401 的 resource_metadata 指這裡）
export const dynamic = "force-dynamic";
export const GET = (req: Request) => handlePrm(req);
export const OPTIONS = () => corsPreflight();
