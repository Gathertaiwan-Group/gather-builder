/**
 * 點數／儲值金帳本的「狀態」純函式——與 SQL builder_ledger_state（0030）逐行同一套規則，記憶體 Store 與會員中心顯示都用它。
 *
 * 2026-10 第五六批審查 H1：舊版把「總消耗」重新依到期日分配到批次，退回會讓點數回到「最後被用掉的批次」，
 * 導致「A 已到期後才退回原本耗 A 的單」時，點數跑到 B（未到期）而復活。改為**依時間順序重播帳本**：
 *
 * - 帳本只增不改，依寫入順序（seq）逐筆處理，所以每一筆扣帳「當時」從哪些批次扣了多少是確定的、不會被事後改寫
 *   （＝把分配明細記在只增不改的帳本上，重播即得；不需要另一張可被改寫的分配表）。
 * - 批次（lot）＝正數且非退回的分錄（earn／topup／adjust＋），可帶到期日（null＝不到期）。
 * - 扣帳（負數）：expire 只從「當時已到期」的批次扣；其他扣帳只從「當時未到期」的批次扣，依到期日先後（FIFO，null 最後），
 *   收回已賺點數／儲值（reverse−）優先扣同一張訂單產生的批次。扣不到的部分不分配（餘額仍照實記）。
 * - 退回（reverse＋／refund＋）：**退回原扣帳的批次**——優先同一張訂單的 redeem／spend 分配（由新到舊），
 *   不足再退回其他 redeem／spend 的分配（由新到舊），仍不足才成為一個不到期的新批次。
 *   🔴 原批次已到期 → 退回的部分仍屬於那個已到期批次 → 算入 expiredDue（下一次記帳寫成 expire），**不會復活**。
 * - 結果：balance＝加總；expiredDue＝已到期批次的剩餘（不超過 balance）；available＝min(未到期批次剩餘, balance − expiredDue)。
 */
export interface LedgerEntryLike {
  kind: string;
  amount: number;
  expires_at: string | null;
  created_at: string;
  order_id?: string | null;
  /** 寫入順序（DB：seq 欄位；記憶體：插入序）。重播依此排序 */
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
/** 會被「退回」對應的扣帳種類 */
const RETURNABLE = new Set(["redeem", "spend"]);

export function isLot(e: Pick<LedgerEntryLike, "kind" | "amount">) {
  return e.amount > 0 && !CREDIT_BACK.has(e.kind);
}

const seqNum = (s: number | string | undefined, i: number) => (typeof s === "number" ? s : s != null && /^\d+$/.test(String(s)) ? Number(s) : i);

interface Lot {
  amount: number;
  remaining: number;
  expMs: number; // Infinity＝不到期
  expiresAt: string | null;
  orderId: string | null;
  seq: number;
}

export function computeLedgerState(entriesIn: LedgerEntryLike[], nowMs = Date.now()): LedgerStateView {
  const entries = entriesIn.map((e, i) => ({ e, s: seqNum(e.seq, i) })).sort((a, b) => a.s - b.s);
  const lots: Lot[] = [];
  const allocs: { orderId: string | null; lot: number; amt: number }[] = [];
  let balance = 0;
  for (const { e, s } of entries) {
    balance += e.amount;
    const t = Date.parse(e.created_at);
    const orderId = e.order_id ?? null;
    if (isLot(e)) {
      lots.push({ amount: e.amount, remaining: e.amount, expMs: e.expires_at ? Date.parse(e.expires_at) : Infinity, expiresAt: e.expires_at, orderId, seq: s });
      continue;
    }
    if (e.amount < 0) {
      let need = -e.amount;
      const preferOrder = e.kind === "reverse" && orderId ? orderId : null;
      while (need > 0) {
        let best = -1;
        for (let i = 0; i < lots.length; i++) {
          const l = lots[i]!;
          if (l.remaining <= 0) continue;
          const ok = e.kind === "expire" ? l.expMs <= t : l.expMs > t;
          if (!ok) continue;
          if (best < 0 || better(l, lots[best]!, preferOrder)) best = i;
        }
        if (best < 0) break;
        const take = Math.min(need, lots[best]!.remaining);
        lots[best]!.remaining -= take;
        need -= take;
        if (RETURNABLE.has(e.kind)) allocs.push({ orderId, lot: best, amt: take });
      }
      continue;
    }
    // 退回：回到原扣帳的批次（由新到舊）
    let give = e.amount;
    const undo = (match: (a: (typeof allocs)[number]) => boolean) => {
      for (let i = allocs.length - 1; i >= 0 && give > 0; i--) {
        const a = allocs[i]!;
        if (a.amt <= 0 || !match(a)) continue;
        const take = Math.min(give, a.amt);
        a.amt -= take;
        lots[a.lot]!.remaining += take;
        give -= take;
      }
    };
    if (orderId) undo((a) => a.orderId === orderId);
    if (give > 0) undo(() => true);
    if (give > 0) lots.push({ amount: give, remaining: give, expMs: Infinity, expiresAt: null, orderId, seq: s });
  }
  const live = (l: Lot) => l.expMs > nowMs;
  const liveSum = lots.filter(live).reduce((n, l) => n + l.remaining, 0);
  const expiredRaw = lots.filter((l) => !live(l)).reduce((n, l) => n + l.remaining, 0);
  const expiredDue = Math.max(0, Math.min(expiredRaw, balance));
  const available = Math.max(0, Math.min(liveSum, balance - expiredDue));
  const next = lots.filter((l) => l.remaining > 0 && live(l) && l.expiresAt).map((l) => l.expiresAt!).sort()[0] ?? null;
  const ordered = lots.slice().sort((a, b) => a.expMs - b.expMs || a.seq - b.seq);
  return { balance, available, expiredDue, nextExpiry: next, lots: ordered.map((l) => ({ amount: l.amount, remaining: l.remaining, expiresAt: l.expiresAt })) };
}

/** a 是否比 b 優先被扣：同訂單優先 → 到期日早 → 寫入早 */
function better(a: Lot, b: Lot, preferOrder: string | null): boolean {
  if (preferOrder) {
    const pa = a.orderId === preferOrder ? 0 : 1;
    const pb = b.orderId === preferOrder ? 0 : 1;
    if (pa !== pb) return pa < pb;
  }
  if (a.expMs !== b.expMs) return a.expMs < b.expMs;
  return a.seq < b.seq;
}
