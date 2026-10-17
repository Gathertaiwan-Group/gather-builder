// e2e 腳本共用：用官方 MCP SDK client 連 /api/mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function connect(base, token, name = "gb-e2e") {
  const transport = new StreamableHTTPClientTransport(new URL("/api/mcp", base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  return {
    client,
    /** 呼叫工具；成功回 parsed JSON，失敗回 { __error: "[code] message" } */
    async call(tool, args = {}) {
      const r = await client.callTool({ name: tool, arguments: args });
      const text = r.content?.[0]?.text ?? "";
      if (r.isError) return { __error: text };
      try {
        return JSON.parse(text);
      } catch {
        return { __raw: text };
      }
    },
    close: () => client.close(),
  };
}

let failures = 0;
export function check(cond, label, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}
export function done() {
  console.log(failures ? `\n${failures} 項失敗` : "\n全部通過");
  process.exit(failures ? 1 : 0);
}

export async function getText(url) {
  const res = await fetch(url, { cache: "no-store" });
  return { status: res.status, body: await res.text() };
}
