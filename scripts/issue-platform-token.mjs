#!/usr/bin/env node
// 發行一組平台級 MCP token（bootstrap 用；之後可在 /admin/tokens 發行）。
// 用法：node --env-file=.env.local scripts/issue-platform-token.mjs "名稱" [--save-env .env.local] [--var NAME]
//   --save-env：把原文寫進指定 env 檔（不印在終端），否則印出一次。
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--")) ?? "platform bootstrap";
const saveIdx = args.indexOf("--save-env");
const saveTo = saveIdx >= 0 ? args[saveIdx + 1] : null;
const varIdx = args.indexOf("--var");
const varName = varIdx >= 0 ? args[varIdx + 1] : "GB_PLATFORM_TOKEN";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("需要 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const raw = `gbp_${randomBytes(32).toString("base64url")}`;
const row = {
  tenant_id: null,
  name,
  token_hash: createHash("sha256").update(raw).digest("hex"),
  token_prefix: raw.slice(0, 10),
  scopes: ["platform:sites", "site:read", "content:write", "design:write", "modules:write", "publish", "inquiries:read"],
};
const res = await fetch(`${url}/rest/v1/builder_api_tokens`, {
  method: "POST",
  headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify(row),
});
if (!res.ok) {
  console.error("建立失敗", res.status, await res.text());
  process.exit(1);
}
const [created] = await res.json();
await fetch(`${url}/rest/v1/builder_audit_log`, {
  method: "POST",
  headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ tenant_id: null, actor: "script:issue-platform-token", action: "token.issue", payload: { tokenId: created.id, name, platform: true } }),
});

if (saveTo) {
  const line = `${varName}=${raw}\n`;
  if (existsSync(saveTo)) {
    const cur = readFileSync(saveTo, "utf8").split("\n").filter((l) => !l.startsWith(`${varName}=`));
    writeFileSync(saveTo, cur.filter(Boolean).join("\n") + "\n" + line);
  } else appendFileSync(saveTo, line);
  console.log(`已建立平台 token ${created.token_prefix}…（id ${created.id}），原文已寫入 ${saveTo} 的 ${varName}`);
} else {
  console.log(`已建立平台 token（id ${created.id}），原文只顯示這一次：\n${raw}`);
}
