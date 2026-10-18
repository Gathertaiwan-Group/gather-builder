import QRCode from "qrcode";

/**
 * QR 產生（不依賴外部服務：npm qrcode，本機運算）。錯誤更正等級 M、邊界 1 模組。
 * SVG 給標籤頁內嵌與 MCP；PNG 給下載。
 */
export async function qrSvg(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return svg.replace(/^<\?xml[^>]*>\s*/, "").trim();
}

export async function qrPng(text: string, size = 512): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", errorCorrectionLevel: "M", margin: 1, width: Math.max(128, Math.min(2048, size)) });
}
