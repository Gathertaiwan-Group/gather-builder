import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateBearer } from "@/lib/tokens";
import { getStore } from "@/lib/store";
import { makeContext, baseUrlFrom } from "@/lib/runtime";
import { registerTools } from "@/lib/mcp/tools";

/**
 * MCP server（Streamable HTTP，無狀態：每個 request 建一個 server＋transport）。
 *
 * 認證：自己驗 `Authorization: Bearer <token>`（lib/tokens.ts authenticateBearer）。
 * 🔴 刻意不用 withMcpAuth、不提供 /.well-known/oauth-*、401 不帶 resource_metadata：
 *    靜態 token 沒有 authorization server，吐 OAuth discovery 會讓客戶端誤走 OAuth 而連不上。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized", message: "缺少或無效的 Bearer token" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
  });
}

/** Origin 檢查（規範 MUST）：沒帶 Origin 是正常的伺服器對伺服器呼叫 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const self = new URL(baseUrlFrom(req)).origin;
  if (origin === self || origin === "https://claude.ai") return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function handle(req: Request): Promise<Response> {
  if (!originAllowed(req)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const actor = await authenticateBearer(getStore(), req.headers.get("authorization"));
  if (!actor) return unauthorized();

  if (req.method !== "POST") {
    // 無狀態模式不提供 GET SSE 串流與 session 刪除
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json", allow: "POST" } });
  }

  const server = new McpServer(
    { name: "gather-builder", version: "0.1.0" },
    {
      instructions:
        "Gather Builder 建站平台。流程：list_modules → create_site（平台 token）→ get_site / list_section_types → add_section / update_section / update_theme → preview_changes（把預覽網址給使用者看）→ 使用者同意後 publish_site confirm:true。所有內容修改只進草稿；每次發布留版本，可 rollback。",
    },
  );
  registerTools(server, makeContext(actor, req));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close().catch(() => undefined);
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
