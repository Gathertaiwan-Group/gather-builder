/**
 * 可預約時段計算（純函式，沒有 I/O；「現在」由呼叫端傳入）。時間一律以 Asia/Taipei（固定 UTC+8、無夏令時間）換算，
 * 與伺服器所在時區無關（Vercel 是 UTC）。
 *
 * 每一天（台北日期 D）：
 *   windows = 有 closed 例外 → [] ，否則每週時段(weekday(D))；再加上 open 例外（加開）
 *   候選開始時間 = 每個 window 從 start 起每 stepMin 一格，且 start + duration ≤ window.end
 *   一格可約 ⇔ start ≥ now + minLead、start < now + maxAdvanceDays、且 [start, start+duration+buffer) 不與任何「占用區間」重疊
 *   占用區間＝既有有效預約的 [starts_at, block_until)（block_until＝結束＋該預約服務的緩衝），所以前一筆的緩衝、跨午夜的預約都會擋到
 */

export interface WeeklyRule {
  /** 0＝週日 … 6＝週六（台北） */
  weekday: number;
  startMin: number;
  endMin: number;
}
export interface DateOverride {
  /** 台北日期 YYYY-MM-DD */
  date: string;
  kind: "closed" | "open";
  startMin?: number | null;
  endMin?: number | null;
}
export interface Busy {
  start: Date | string;
  /** 結束＋緩衝 */
  end: Date | string;
}
export interface AvailabilityInput {
  now: Date;
  /** 從哪一天開始（台北日期，預設今天） */
  fromDate?: string;
  days: number;
  weekly: WeeklyRule[];
  overrides: DateOverride[];
  busy: Busy[];
  durationMin: number;
  bufferMin: number;
  stepMin: number;
  minLeadMin: number;
  maxAdvanceDays: number;
}
export interface Slot {
  start: string;
  end: string;
}
export interface DaySlots {
  date: string;
  weekday: number;
  slots: Slot[];
}

const MIN = 60_000;
const DAY = 86_400_000;
const TPE = 8 * 3600_000;

export function taipeiDateOf(d: Date | number): string {
  return new Date(new Date(d).getTime() + TPE).toISOString().slice(0, 10);
}
/** 台北日期的 00:00（UTC 時刻，毫秒） */
export function taipeiMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** 某天的可營業區間（分鐘，可能多段），已合併重疊 */
export function dayWindows(date: string, weekly: WeeklyRule[], overrides: DateOverride[]): [number, number][] {
  const own = overrides.filter((o) => o.date === date);
  const closed = own.some((o) => o.kind === "closed");
  const w: [number, number][] = closed ? [] : weekly.filter((r) => r.weekday === weekdayOf(date)).map((r) => [r.startMin, r.endMin]);
  for (const o of own) if (o.kind === "open" && o.startMin != null && o.endMin != null && o.endMin > o.startMin) w.push([o.startMin, o.endMin]);
  w.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of w) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

export function computeAvailability(input: AvailabilityInput): DaySlots[] {
  const nowMs = input.now.getTime();
  const earliest = nowMs + input.minLeadMin * MIN;
  const latest = nowMs + input.maxAdvanceDays * DAY;
  const busy = input.busy.map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()] as const);
  const step = Math.max(5, input.stepMin);
  const out: DaySlots[] = [];
  const first = input.fromDate ?? taipeiDateOf(input.now);
  for (let i = 0; i < input.days; i++) {
    const date = addDays(first, i);
    const midnight = taipeiMidnight(date);
    if (midnight > latest) break;
    const slots: Slot[] = [];
    for (const [ws, we] of dayWindows(date, input.weekly, input.overrides)) {
      for (let m = ws; m + input.durationMin <= we; m += step) {
        const s = midnight + m * MIN;
        const e = s + input.durationMin * MIN;
        const block = e + input.bufferMin * MIN;
        if (s < earliest || s >= latest) continue;
        if (busy.some(([bs, be]) => overlaps(s, block, bs, be))) continue;
        slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
      }
    }
    out.push({ date, weekday: weekdayOf(date), slots });
  }
  return out;
}

/** 這個開始時間是否為可約時段（建立／改期時的權威檢查之一；同時段衝突另由 DB 交易保證） */
export function isBookable(input: Omit<AvailabilityInput, "fromDate" | "days">, startIso: string): Slot | null {
  const date = taipeiDateOf(new Date(startIso));
  const day = computeAvailability({ ...input, fromDate: date, days: 1 })[0];
  const want = new Date(startIso).getTime();
  return day?.slots.find((s) => new Date(s.start).getTime() === want) ?? null;
}

/** 自助取消／改期期限：開始前 deadlineHours 小時以前才可以 */
export function canSelfCancel(startsAt: Date | string, now: Date, deadlineHours: number): boolean {
  return new Date(startsAt).getTime() - now.getTime() >= deadlineHours * 3600_000;
}

/** "HH:MM" ↔ 分鐘 */
export function parseHm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return NaN;
  return h * 60 + mi;
}
export const fmtHm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
