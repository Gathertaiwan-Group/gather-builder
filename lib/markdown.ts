import { Marked, type Tokens } from "marked";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SAFE_URL = /^(https?:\/\/|\/(?!\/)|#|mailto:|tel:)/i;

/**
 * Markdown → HTML。內容來自租戶或 agent，屬於不可信輸入：
 * 原始 HTML 一律轉義、連結與圖片只允許安全協定。
 */
const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link) {
      const label = this.parser.parseInline(token.tokens);
      if (!SAFE_URL.test(token.href)) return label;
      const ext = /^https?:\/\//i.test(token.href);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(token.href)}"${title}${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
    },
    image(token: Tokens.Image) {
      if (!/^(https:\/\/|\/(?!\/))/i.test(token.href)) return escapeHtml(token.text);
      return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" loading="lazy" />`;
    },
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false }) as string;
}
