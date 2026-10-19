import { MODULES, getModule, resolveDependencies, DependencyError } from "@/modules/registry";

/**
 * /build 計價：唯一的計價入口（頁面顯示、MCP get_build_quote、建單都用它）。前端送的價格一律不採信。
 * - 必備：core（月費＝平台基本費）＋ sections-basic（首頁區塊）。
 * - 勾選的模組自動帶入依賴（resolveDependencies）。
 * - existing＝租戶已購買的模組（加購時扣掉，不重複收費）。
 * - 第一次付款＝建置費合計＋第一個月月費；之後每月寄帳單連結（PChomePay 沒有定期扣款，見 ARCHITECTURE「平台收費」）。
 */
export const BASE_MODULES = ["core", "sections-basic"] as const;

export interface QuoteLine {
  id: string;
  name: string;
  description: string;
  priceSetup: number;
  priceMonthly: number;
  requires: string[];
  /** 不是使用者勾的，是依賴自動帶入（或必備） */
  autoAdded: boolean;
}

export interface BuildQuote {
  lines: QuoteLine[];
  setupTotal: number;
  monthlyTotal: number;
  /** 這次要付的金額（建置費＋第一個月） */
  firstPayment: number;
  /** 加購時：加購後的新月費合計（含既有） */
  monthlyAfter?: number;
}

export class QuoteError extends Error {}

export function quoteBuild(requested: string[], opts: { existing?: string[]; existingMonthly?: number; includeBase?: boolean } = {}): BuildQuote {
  const unique = [...new Set(requested.map((x) => String(x).trim()).filter(Boolean))];
  if (unique.length > 40) throw new QuoteError("模組太多");
  for (const id of unique) if (!getModule(id)) throw new QuoteError(`未知模組：${id}`);
  const base = opts.includeBase === false ? [] : [...BASE_MODULES];
  let all: string[];
  try {
    all = resolveDependencies([...base, ...unique]);
  } catch (e) {
    if (e instanceof DependencyError) throw new QuoteError(e.message);
    throw e;
  }
  const owned = new Set(opts.existing ?? []);
  const lines: QuoteLine[] = all
    .filter((id) => !owned.has(id))
    .map((id) => {
      const m = getModule(id)!;
      return { id, name: m.name, description: m.description, priceSetup: m.priceSetup, priceMonthly: m.priceMonthly, requires: m.requires, autoAdded: !unique.includes(id) };
    });
  const setupTotal = lines.reduce((a, l) => a + l.priceSetup, 0);
  const monthlyTotal = lines.reduce((a, l) => a + l.priceMonthly, 0);
  return {
    lines,
    setupTotal,
    monthlyTotal,
    firstPayment: setupTotal + monthlyTotal,
    ...(opts.existing ? { monthlyAfter: (opts.existingMonthly ?? 0) + monthlyTotal } : {}),
  };
}

/** /build 頁面用：可勾選的模組目錄（排除必備的） */
export function buildCatalog() {
  return MODULES.map((m) => ({ id: m.id, name: m.name, description: m.description, category: m.category, priceSetup: m.priceSetup, priceMonthly: m.priceMonthly, requires: m.requires, base: (BASE_MODULES as readonly string[]).includes(m.id) }));
}
