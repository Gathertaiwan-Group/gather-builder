/** 台北今天 00:00 的 ISO（固定 UTC+8；店主手動調整的每日上限用）。獨立葉節點，避免 loyalty ↔ wallet 互相 import */
export function taipeiDayStartIso(now = Date.now()) {
  const t = now + 8 * 3600_000;
  return new Date(t - (t % 86400_000) - 8 * 3600_000).toISOString();
}
