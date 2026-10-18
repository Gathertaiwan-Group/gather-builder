import { manifest as core } from "./core/manifest";
import { manifest as sectionsBasic } from "./sections-basic/manifest";
import { manifest as blog } from "./blog/manifest";
import { manifest as portfolio } from "./portfolio/manifest";
import { manifest as contactForm } from "./contact-form/manifest";
import { manifest as line } from "./line/manifest";
import { manifest as members } from "./members/manifest";
import { manifest as shop } from "./shop/manifest";
import { manifest as invoice } from "./invoice/manifest";
import { manifest as shipping } from "./shipping/manifest";
import { manifest as coupons } from "./coupons/manifest";
import { manifest as referral } from "./referral/manifest";
import { manifest as newsletter } from "./newsletter/manifest";
import { manifest as aiChat } from "./ai-chat/manifest";
import { manifest as events } from "./events/manifest";
import { manifest as booking } from "./booking/manifest";
import { manifest as courses } from "./courses/manifest";
import { manifest as loyalty } from "./loyalty/manifest";
import { manifest as storedValue } from "./stored-value/manifest";
import { manifest as i18n } from "./i18n/manifest";
import type { ModuleManifest, SectionTypeDef } from "./types";

/** 模組註冊表：程式內唯一真相。新增模組只要在這裡加一行。 */
export const MODULES: ModuleManifest[] = [core, sectionsBasic, blog, portfolio, contactForm, line, members, shop, invoice, shipping, coupons, referral, newsletter, aiChat, events, booking, courses, loyalty, storedValue, i18n];

export type Registry = Map<string, ModuleManifest>;
export const registry: Registry = new Map(MODULES.map((m) => [m.id, m]));

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}

export function getModule(id: string, reg: Registry = registry): ModuleManifest | undefined {
  return reg.get(id);
}

/**
 * 依賴解析：回傳「要開啟的模組」的完整清單（依賴在前），自動帶入間接依賴。
 * 未知模組或循環依賴丟 DependencyError。
 */
export function resolveDependencies(requested: string[], reg: Registry = registry): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const visiting: string[] = [];

  const visit = (id: string) => {
    if (done.has(id)) return;
    const idx = visiting.indexOf(id);
    if (idx >= 0) {
      throw new DependencyError(`模組依賴循環：${[...visiting.slice(idx), id].join(" → ")}`);
    }
    const m = reg.get(id);
    if (!m) throw new DependencyError(`未知模組：${id}（可用：${[...reg.keys()].join(", ")}）`);
    visiting.push(id);
    for (const dep of m.requires) visit(dep);
    visiting.pop();
    done.add(id);
    order.push(id);
  };

  for (const id of requested) visit(id);
  return order;
}

/**
 * 停用檢查：被其他「仍啟用」模組依賴、或是鎖定模組時，回傳拒絕原因；可停用回 null。
 */
export function checkDisable(id: string, enabled: Iterable<string>, reg: Registry = registry): string | null {
  const m = reg.get(id);
  if (!m) return `未知模組：${id}`;
  if (m.locked) return `${m.name}（${id}）是必備模組，不能停用`;
  const dependents = [...enabled].filter((other) => other !== id && reg.get(other)?.requires.includes(id));
  if (dependents.length) {
    return `無法停用 ${id}：下列已啟用模組依賴它：${dependents.join(", ")}。請先停用它們。`;
  }
  return null;
}

/** 區塊類型 → 提供它的模組 */
export function findSectionType(type: string, reg: Registry = registry): { module: ModuleManifest; def: SectionTypeDef } | undefined {
  for (const m of reg.values()) {
    const def = m.sectionTypes.find((s) => s.type === type);
    if (def) return { module: m, def };
  }
  return undefined;
}

export function allSectionTypes(reg: Registry = registry): { module: ModuleManifest; def: SectionTypeDef }[] {
  return [...reg.values()].flatMap((m) => m.sectionTypes.map((def) => ({ module: m, def })));
}

/** 驗證區塊 props；回傳已套用預設值的 props 或錯誤訊息清單 */
export function validateSectionProps(
  type: string,
  props: unknown,
  reg: Registry = registry,
): { ok: true; props: Record<string, unknown> } | { ok: false; errors: string[] } {
  const found = findSectionType(type, reg);
  if (!found) return { ok: false, errors: [`未知區塊類型：${type}`] };
  const r = found.def.schema.safeParse(props ?? {});
  if (r.success) return { ok: true, props: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(props)"}: ${i.message}`),
  };
}
