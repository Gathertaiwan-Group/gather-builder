import { describe, expect, it } from "vitest";
import { createPreviewToken, verifyPreviewToken } from "@/lib/preview";

const SECRET = "test-secret-123456";
const T = "11111111-1111-1111-1111-111111111111";

describe("預覽簽章", () => {
  it("有效 token 通過", () => {
    expect(verifyPreviewToken(createPreviewToken(T, SECRET), T, SECRET)).toEqual({ ok: true });
  });
  it("過期被拒", () => {
    const tok = createPreviewToken(T, SECRET, Date.now() - 2 * 3600_000);
    expect(verifyPreviewToken(tok, T, SECRET)).toEqual({ ok: false, reason: "expired" });
  });
  it("竄改 payload（延長期限）被拒", () => {
    const tok = createPreviewToken(T, SECRET, Date.now() - 2 * 3600_000);
    const [, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ t: T, e: Math.floor(Date.now() / 1000) + 99999 })).toString("base64url");
    expect(verifyPreviewToken(`${forged}.${sig}`, T, SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("錯誤 secret 簽的被拒", () => {
    expect(verifyPreviewToken(createPreviewToken(T, "other-secret-xx"), T, SECRET).ok).toBe(false);
  });
  it("別的租戶的 token 被拒", () => {
    const tok = createPreviewToken("22222222-2222-2222-2222-222222222222", SECRET);
    expect(verifyPreviewToken(tok, T, SECRET)).toEqual({ ok: false, reason: "wrong_tenant" });
  });
  it("格式錯誤被拒", () => {
    expect(verifyPreviewToken("garbage", T, SECRET).ok).toBe(false);
  });
});
