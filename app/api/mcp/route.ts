import { getStore } from "@/lib/store";
import { handleMcp } from "@/lib/mcp/handler";

/** MCP server（實作與說明見 lib/mcp/handler.ts） */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handle = (req: Request) => handleMcp(req, getStore());

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
