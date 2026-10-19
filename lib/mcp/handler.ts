import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateBearer } from "../tokens";
import { authenticateOAuthAccess, isOAuthAccessToken, oauthConfig, wwwAuthenticate } from "../services/oauth";
import type { Store } from "../store/types";
import { makeContext, baseUrlFrom } from "../runtime";
import { registerTools } from "./tools";

/**
 * MCP server（Streamable HTTP，無狀態：每個 request 建一個 server＋transport）。
 *
 * 認證（第九批起兩種都可以）：
 * 1. 手動 Bearer token（gbt_／gbp_，lib/tokens.ts authenticateBearer）：帶上來就直接通過，**不會觸發任何 OAuth 流程**（不回 401）。
 * 2. OAuth 2.1 access token（gboa_，lib/services/oauth.ts）：驗 audience（resource＝這個端點）、授權未撤銷、店主成員仍啟用。
 * 沒帶或無效 → 401＋WWW-Authenticate resource_metadata（RFC 9728），支援 OAuth 的客戶端由此開始 discovery。
 * 🔴 仍不用 withMcpAuth（快樂手的教訓：它會讓靜態 token 也被導去 OAuth）；兩種 token 前綴不同，互不干擾。
 */
function unauthorized(req: Request, invalid: boolean) {
  return new Response(JSON.stringify({ error: invalid ? "invalid_token" : "unauthorized", message: "缺少或無效的 token（可用手動 Bearer token，或依 WWW-Authenticate 走 OAuth）" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": wwwAuthenticate(oauthConfig(baseUrlFrom(req)), invalid ? "invalid_token" : undefined) },
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

/** MCP 入口（store 可注入，方便測試） */
export async function handleMcp(req: Request, store: Store): Promise<Response> {
  if (!originAllowed(req)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const authz = req.headers.get("authorization");
  const raw = /^Bearer\s+(\S+)$/i.exec(authz?.trim() ?? "")?.[1] ?? "";
  const actor = raw && isOAuthAccessToken(raw) ? await authenticateOAuthAccess(store, raw, oauthConfig(baseUrlFrom(req)).resource) : await authenticateBearer(store, authz);
  if (!actor) return unauthorized(req, !!authz);

  if (req.method !== "POST") {
    // 無狀態模式不提供 GET SSE 串流與 session 刪除
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json", allow: "POST" } });
  }

  const server = new McpServer(
    { name: "gather-builder", version: "0.1.0" },
    {
      instructions:
        "Gather Builder 建站平台。流程：list_modules → create_site（平台 token）→ get_site / list_section_types → add_section / update_section / update_theme → preview_changes（把預覽網址給使用者看）→ 使用者同意後 publish_site confirm:true。所有內容修改只進草稿；每次發布留版本，可 rollback。電商：enable_module shop → configure_module shop（運費、線下匯款）→ create_product（上架需 confirm）→ 訂單用 list_orders / mark_order_paid / fulfill_order / cancel_order（都需 confirm）。金流金鑰只能由平台擁有者在後台輸入，請勿要求使用者在對話中提供金鑰。",
    },
  );
  registerTools(server, makeContext(actor, req, store));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    // 第九批審查 M4：OAuth token 的 scope 不足 → HTTP 403＋WWW-Authenticate insufficient_scope（step-up）；手動 token 維持工具錯誤
    if (actor.oauthGrantId && res.status === 200 && (res.headers.get("content-type") ?? "").includes("application/json")) {
      const text = await res.text();
      const need = /\[forbidden\] 權限不足：這個動作需要 scope「([a-z:]+)」/.exec(text)?.[1];
      const headers = new Headers(res.headers);
      if (need) {
        headers.set("www-authenticate", wwwAuthenticate(oauthConfig(baseUrlFrom(req)), "insufficient_scope", [need]));
        return new Response(text, { status: 403, headers });
      }
      return new Response(text, { status: res.status, headers });
    }
    return res;
  } finally {
    void server.close().catch(() => undefined);
  }
}

