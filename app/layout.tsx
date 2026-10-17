import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Gather Builder｜給樂數位 模組化建站平台", template: "%s" },
  description: "勾選模組就能組出網站，AI agent 也能透過 MCP 開站、改內容、發布。",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant-TW">
      <body>{children}</body>
    </html>
  );
}
