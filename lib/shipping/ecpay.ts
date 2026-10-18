import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ShipmentStatus } from "../store/types";

/**
 * 綠界物流（ECPay Logistics）。依官方「物流整合 API 技術文件」https://developers.ecpay.com.tw/?p=7380 ：
 *   門市電子地圖  POST /Express/map（瀏覽器表單導轉；選完門市由綠界頁面 POST 回 ServerReplyURL，沒有 CheckMacValue）
 *   建立物流訂單  POST /Express/Create（幕後；回應 `1|key=value&…` 或 `0|錯誤訊息`，回應內含 CheckMacValue）
 *   物流狀態通知  綠界 POST 到 ServerReplyURL，必須驗 CheckMacValue，正確後回純文字 `1|OK`
 *   測試環境 https://logistics-stage.ecpay.com.tw；正式 https://logistics.ecpay.com.tw
 *
 * 🔴 Realreal 實戰眉角（memory project_realreal_ecpay_cvs_gotchas）：
 * 1. 收件人姓名：中文 2–5 字或英文 4–10 字，不可中英數混合、不可含數字／空白／符號（違反 → 10500036）。
 * 2. Create 回應是 pipe 格式：`1|<urlencoded>` 只能解析尾段；C2C 成功的 RtnCode 是 300（B2C 是 1）。
 */

export const ECPAY_LOGISTICS_BASE = { stage: "https://logistics-stage.ecpay.com.tw", prod: "https://logistics.ecpay.com.tw" } as const;

/**
 * 綠界官方公開的測試特店（https://developers.ecpay.com.tw/?p=7398「測試介接資訊」）。
 * 🔴 官方公開測試值，只能用在測試環境（stage）。
 */
export const ECPAY_STAGE_TEST_MERCHANTS = {
  C2C: { merchantId: "2000933", hashKey: "XBERn1YOvpM9nfZc", hashIv: "h1ONHk4P4yqbl5LK" },
  B2C: { merchantId: "2000132", hashKey: "5294y06JbISpM5x9", hashIv: "v77hoKGq4kWxNNIS" },
} as const;

export const CVS_SUBTYPES = {
  C2C: ["UNIMARTC2C", "FAMIC2C", "HILIFEC2C", "OKMARTC2C"],
  B2C: ["UNIMART", "FAMI", "HILIFE", "UNIMARTFREEZE"],
} as const;
export const HOME_SUBTYPES = ["TCAT", "POST"] as const;
export const ALL_CVS_SUBTYPES: string[] = [...CVS_SUBTYPES.C2C, ...CVS_SUBTYPES.B2C];

export const CVS_LABEL: Record<string, string> = {
  UNIMARTC2C: "7-ELEVEN 交貨便",
  FAMIC2C: "全家店到店",
  HILIFEC2C: "萊爾富店到店",
  OKMARTC2C: "OK 店到店",
  UNIMART: "7-ELEVEN",
  FAMI: "全家",
  HILIFE: "萊爾富",
  UNIMARTFREEZE: "7-ELEVEN 冷凍",
};

export interface EcpayCreds {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  stage: boolean;
}

/**
 * .NET 的 HttpUtility.UrlEncode（綠界「URLEncode 轉換表」的 .NET 欄位）：
 * 空白 → +；- _ . ! * ( ) 不編碼；~ 與 ' 要編碼（encodeURIComponent 不會編它們）。
 */
export function dotnetUrlEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+").replace(/~/g, "%7E").replace(/'/g, "%27");
}

/**
 * CheckMacValue（官方「檢查碼機制說明」https://developers.ecpay.com.tw/?p=7424 ，物流用 MD5）：
 * 1. 參數（不含 CheckMacValue）依名稱 A→Z 排序（不分大小寫），以 & 串接
 * 2. 前加 HashKey=…&、後加 &HashIV=…
 * 3. .NET URL encode → 4. 轉小寫 → 5. MD5 → 6. 轉大寫
 */
export function checkMacValue(params: Record<string, string>, hashKey: string, hashIv: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "CheckMacValue")
    .sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const raw = `HashKey=${hashKey}&${keys.map((k) => `${k}=${params[k] ?? ""}`).join("&")}&HashIV=${hashIv}`;
  return createHash("md5").update(dotnetUrlEncode(raw).toLowerCase()).digest("hex").toUpperCase();
}

/** 常數時間比較 CheckMacValue（不分大小寫）；格式不對直接 false */
export function verifyCheckMacValue(params: Record<string, string>, hashKey: string, hashIv: string): boolean {
  const got = (params.CheckMacValue ?? "").trim().toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(got)) return false;
  const want = checkMacValue(params, hashKey, hashIv);
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** Express/Create 的回應：`1|key=value&…`（只解析尾段）或 `0|錯誤訊息`；也相容純 key=value */
export function parseEcpayResponse(text: string): { ok: boolean; fields: Record<string, string>; message: string } {
  const m = /^\s*(\d+)\|([\s\S]*)$/.exec(text);
  if (m) {
    const [, sync, rest] = m;
    if (sync === "1" && rest!.includes("=")) {
      const fields = Object.fromEntries(new URLSearchParams(rest!.trim()));
      for (const k of Object.keys(fields)) fields[k] = fields[k]!.trim();
      return { ok: true, fields, message: fields.RtnMsg ?? "" };
    }
    return { ok: false, fields: { RtnCode: sync! }, message: rest!.trim() };
  }
  const fields = Object.fromEntries(new URLSearchParams(text.trim()));
  return { ok: !!fields.AllPayLogisticsID, fields, message: fields.RtnMsg ?? text.slice(0, 200) };
}

/** 收件人姓名（超商與宅配同規則）：中文 2–5 字（可含間隔號 ·）或英文 4–10 字，不可混合、不可含數字空白符號 */
export function isValidEcpayName(name: string): boolean {
  const n = name.trim();
  return /^[㐀-鿿豈-﫿·]{2,5}$/.test(n) || /^[A-Za-z]{4,10}$/.test(n);
}
export const ECPAY_NAME_RULE = "收件人姓名需為中文 2–5 字或英文 4–10 字，不可含數字、空白或符號（綠界規定）";
export const isValidCellPhone = (p: string) => /^09\d{8}$/.test(p.replace(/[\s-]/g, ""));

/** 隨機 MerchantTradeNo（20 碼英數，~113 bits）：同時是電子地圖選店的查詢鍵，不可被猜到 */
export function randomTradeNo(prefix = "G"): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = randomBytes(20);
  let s = prefix;
  for (const b of buf) {
    if (s.length >= 20) break;
    s += A[b % A.length];
  }
  return s;
}

/** yyyy/MM/dd HH:mm:ss（台北時間） */
export function ecpayDate(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/** 電子地圖表單（瀏覽器自動 POST 到綠界） */
export function mapForm(creds: Pick<EcpayCreds, "merchantId" | "stage">, input: { tradeNo: string; subType: string; serverReplyUrl: string; mobile: boolean; extra?: string }) {
  return {
    action: `${creds.stage ? ECPAY_LOGISTICS_BASE.stage : ECPAY_LOGISTICS_BASE.prod}/Express/map`,
    fields: {
      MerchantID: creds.merchantId,
      MerchantTradeNo: input.tradeNo,
      LogisticsType: "CVS",
      LogisticsSubType: input.subType,
      IsCollection: "N",
      ServerReplyURL: input.serverReplyUrl,
      ExtraData: (input.extra ?? "").slice(0, 20),
      Device: input.mobile ? "1" : "0",
    } as Record<string, string>,
  };
}

/**
 * 物流狀態代碼 → 出貨單狀態（官方「物流狀態通知」常用 RtnCode 表；其他代碼只記事件不改狀態）。
 */
export function mapLogisticsStatus(rtnCode: string): ShipmentStatus | null {
  const c = rtnCode.trim();
  if (c === "300" || c === "1" || c === "2001" || c === "2101") return "created";
  if (["2030", "3024", "2068", "3006", "3001"].includes(c)) return "in_transit";
  if (["2063", "2073", "3018"].includes(c)) return "arrived";
  if (["2067", "3022", "3003"].includes(c)) return "delivered";
  if (["2074", "3020"].includes(c)) return "returned";
  return null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CreateLogisticsInput {
  tradeNo: string;
  type: "cvs" | "home";
  subType: string;
  goodsAmount: number;
  goodsName: string;
  sender: { name: string; cellPhone: string; zipCode?: string; address?: string };
  receiver: { name: string; cellPhone: string; email: string; storeId?: string; zipCode?: string; address?: string };
  serverReplyUrl: string;
}

export type CreateLogisticsResult =
  | { ok: true; logisticsId: string; trackingNo: string | null; validationNo: string | null; rtnCode: string; raw: Record<string, string> }
  | { ok: false; message: string; raw: Record<string, string> | { text: string } };

/** 幕後建立物流訂單（Express/Create）。成功 = 有 AllPayLogisticsID 且 RtnCode 為 1（B2C／宅配）或 300（C2C），且回應的 CheckMacValue 正確 */
export async function createLogisticsOrder(creds: EcpayCreds, input: CreateLogisticsInput, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<CreateLogisticsResult> {
  const fields: Record<string, string> = {
    MerchantID: creds.merchantId,
    MerchantTradeNo: input.tradeNo,
    MerchantTradeDate: ecpayDate(),
    LogisticsType: input.type === "cvs" ? "CVS" : "HOME",
    LogisticsSubType: input.subType,
    GoodsAmount: String(Math.max(1, Math.min(20000, Math.round(input.goodsAmount)))),
    GoodsName: input.goodsName.replace(/[\^'`!@#%&*+\\"<>|_[\]]/g, "").slice(0, 25) || "網路商品",
    IsCollection: "N",
    SenderName: input.sender.name,
    SenderCellPhone: input.sender.cellPhone,
    ReceiverName: input.receiver.name,
    ReceiverCellPhone: input.receiver.cellPhone.replace(/[\s-]/g, ""),
    ReceiverEmail: input.receiver.email,
    ServerReplyURL: input.serverReplyUrl,
  };
  if (input.type === "cvs") {
    fields.ReceiverStoreID = input.receiver.storeId ?? "";
  } else {
    fields.SenderZipCode = input.sender.zipCode ?? "";
    fields.SenderAddress = input.sender.address ?? "";
    fields.ReceiverZipCode = input.receiver.zipCode ?? "";
    fields.ReceiverAddress = input.receiver.address ?? "";
    fields.Temperature = "0001";
    fields.Distance = "00";
    fields.Specification = "0001";
    fields.ScheduledPickupTime = "4";
    fields.ScheduledDeliveryTime = "4";
    if (input.subType === "POST") fields.GoodsWeight = "1";
  }
  fields.CheckMacValue = checkMacValue(fields, creds.hashKey, creds.hashIv);
  let text: string;
  try {
    const res = await fetchImpl(`${creds.stage ? ECPAY_LOGISTICS_BASE.stage : ECPAY_LOGISTICS_BASE.prod}/Express/Create`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, message: `連線失敗：${e instanceof Error ? e.message : String(e)}`, raw: { text: "" } };
  }
  const r = parseEcpayResponse(text);
  const f = r.fields;
  if (!r.ok || !f.AllPayLogisticsID) return { ok: false, message: `綠界建單失敗 ${f.RtnCode ?? "?"}：${r.message || text.slice(0, 200)}`, raw: { text: text.slice(0, 1000) } };
  if (f.CheckMacValue && !verifyCheckMacValue(f, creds.hashKey, creds.hashIv)) return { ok: false, message: "綠界回應的 CheckMacValue 不正確（拒絕採信）", raw: f };
  if (f.RtnCode !== "300" && f.RtnCode !== "1") return { ok: false, message: `綠界建單狀態 ${f.RtnCode}：${f.RtnMsg ?? ""}`, raw: f };
  return {
    ok: true,
    logisticsId: f.AllPayLogisticsID,
    trackingNo: f.CVSPaymentNo || f.BookingNote || null,
    validationNo: f.CVSValidationNo || null,
    rtnCode: f.RtnCode,
    raw: f,
  };
}
