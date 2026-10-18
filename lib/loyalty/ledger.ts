/**
 * 點數／儲值金帳本的「狀態」純函式——與 SQL builder_ledger_state（0021）同一套規則，記憶體 Store 與會員中心顯示都用它。
 *
 * - 餘額＝所有分錄加總（帳本是唯一真相，沒有可改的餘額欄位）。
 * - 批次（lot）＝正數且不是「退回」的分錄（earn／topup／adjust＋），可帶到期日（null＝不到期，排在最後）。
 * - 消耗＝所有負數分錄（redeem／spend／expire／reverse−／adjust−）減去「退回」（reverse＋／refund＋）。
 * - 依到期日先後（FIFO：最早到期的先用）把消耗分配到批次；分配後還有剩、且已過期的＝expiredDue（下一次寫成 expire）。
 *   退回會讓消耗變少，點數回到最後被用掉的那一批（若那批已到期，下次會再到期）。
 */
export interface LedgerEntryLike {
  kind: string;
  amount: number;
  expires_at: string | null;
  created_at: string;
  /** 同時間的排序鍵（記憶體用插入序；DB 用 id） */
  seq?: number | string;
}

export interface LotView {
  amount: number;
  remaining: number;
  expiresAt: string | null;
}

export interface LedgerStateView {
  balance: number;
  available: number;
  expiredDue: number;
  nextExpiry: string | null;
  lots: LotView[];
}

const CREDIT_BACK = new Set(["reverse", "refund"]);

export function isLot(e: Pick<LedgerEntryLike, "kind" | "amount">) {
  return e.amount > 0 && !CREDIT_BACK.has(e.kind);
}

export function computeLedgerState(entries: LedgerEntryLike[], nowMs = Date.now()): LedgerStateView {
  let balance = 0;
  let consumed = 0;
  for (const e of entries) {
    balance += e.amount;
    if (e.amount < 0) consumed += -e.amount;
    else if (CREDIT_BACK.has(e.kind)) consumed -= e.amount;
  }
  consumed = Math.max(0, consumed);
  const lots = entries
    .filter(isLot)
    .slice()
    .sort((a, b) => {
      const ea = a.expires_at ? Date.parse(a.expires_at) : Infinity;
      const eb = b.expires_at ? Date.parse(b.expires_at) : Infinity;
      if (ea !== eb) return ea - eb;
      const c = a.created_at.localeCompare(b.created_at);
      if (c) return c;
      return String(a.seq ?? "").localeCompare(String(b.seq ?? ""), undefined, { numeric: true });
    });
  let before = 0;
  const views: LotView[] = lots.map((l) => {
    const used = Math.min(l.amount, Math.max(0, consumed - before));
    before += l.amount;
    return { amount: l.amount, remaining: l.amount - used, expiresAt: l.expires_at };
  });
  const live = (v: LotView) => !v.expiresAt || Date.parse(v.expiresAt) > nowMs;
  const availableRaw = views.filter(live).reduce((n, v) => n + v.remaining, 0);
  const expiredDue = views.filter((v) => !live(v)).reduce((n, v) => n + v.remaining, 0);
  const next = views.filter((v) => v.remaining > 0 && v.expiresAt && Date.parse(v.expiresAt) > nowMs).map((v) => v.expiresAt!).sort()[0] ?? null;
  return { balance, available: Math.max(0, Math.min(balance, availableRaw)), expiredDue, nextExpiry: next, lots: views };
}
