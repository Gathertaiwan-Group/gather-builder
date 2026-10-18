import type { ServiceErrorCode } from "../errors";

/** SQL raise 'builder: <key>' → 給客人／agent 看的訊息（memory store 共用同一份） */
export const RESERVE_ERRORS: Record<string, { code: ServiceErrorCode; message: string }> = {
  "session not found": { code: "not_found", message: "找不到這個場次" },
  "session closed": { code: "invalid", message: "這個場次目前不開放報名" },
  "session started": { code: "invalid", message: "活動已開始，無法報名" },
  "ticket unavailable": { code: "invalid", message: "這個票種目前不提供" },
  "ticket not on sale": { code: "invalid", message: "這個票種不在販售期間" },
  "qty limit": { code: "invalid", message: "超過每筆報名的張數上限" },
  "price changed": { code: "conflict", message: "票價已變更，請重新整理頁面再報名" },
  "sold out": { code: "conflict", message: "名額已滿，報名未成立（可以登記候補）" },
  "ticket sold out": { code: "conflict", message: "這個票種已售完，報名未成立" },
  "offer invalid": { code: "conflict", message: "候補保留已過期或無效，請重新登記候補" },
  "slot taken": { code: "conflict", message: "這個時段剛被預約走了，請選擇其他時段" },
  "provider unavailable": { code: "invalid", message: "這位服務人員目前不開放預約" },
  "service unavailable": { code: "invalid", message: "這個服務目前不開放預約" },
  "already registered": { code: "conflict", message: "這個 Email 已報名過這個場次（每個 Email 每場限一筆；要多人參加請在同一筆選張數）" },
  "pending qty": { code: "invalid", message: "尚未確認 Email 的報名每筆限 1 張（登入已驗證的會員帳號可一次報多張）" },
  "pending cap": { code: "conflict", message: "目前待確認的報名太多，已改為登記候補" },
  "booking not found": { code: "not_found", message: "找不到這筆預約" },
};

