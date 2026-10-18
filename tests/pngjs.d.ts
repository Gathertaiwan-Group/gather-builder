// pngjs（qrcode 的相依套件）只在測試裡用來解 PNG 給 jsQR 驗證，最小型別宣告
declare module "pngjs" {
  export const PNG: { sync: { read(buf: Buffer): { width: number; height: number; data: Buffer } } };
}
