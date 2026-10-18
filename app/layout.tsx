import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { htmlLang } from "@/lib/i18n/langs";

export const metadata: Metadata = {
  title: { default: "Gather Builder｜給樂數位 模組化建站平台", template: "%s" },
  description: "勾選模組就能組出網站，AI agent 也能透過 MCP 開站、改內容、發布。",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 多語：middleware 從 /s/<slug>/<lang>/… 帶進來的語言（其他頁面為 zh-Hant-TW）
  const lang = htmlLang((await headers()).get("x-gb-lang"));
  return (
    <html lang={lang}>
      <body>{children}</body>
    </html>
  );
}
