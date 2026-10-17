import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/markdown";

describe("markdown 安全渲染", () => {
  it("原始 HTML 被轉義", () => {
    const html = renderMarkdown("hi <script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("javascript: 連結不輸出 href", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });
  it("正常 markdown", () => {
    const html = renderMarkdown("# 標題\n\n[連結](https://example.com)");
    expect(html).toContain("<h1");
    expect(html).toContain('href="https://example.com"');
  });
});
