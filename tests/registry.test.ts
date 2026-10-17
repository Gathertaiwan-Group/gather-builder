import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkDisable, resolveDependencies, registry, DependencyError, type Registry } from "@/modules/registry";
import type { ModuleManifest } from "@/modules/types";

const fake = (id: string, requires: string[], locked = false): ModuleManifest => ({
  id, name: id, description: id, category: "content", priceSetup: 0, priceMonthly: 0, requires,
  settingsSchema: z.object({}), sectionTypes: [], mcpTools: [], locked,
});

describe("resolveDependencies", () => {
  it("自動帶入直接與間接依賴，依賴排在前面", () => {
    const order = resolveDependencies(["portfolio"]);
    expect(order).toEqual(["core", "sections-basic", "portfolio"]);
  });

  it("重複與已包含的模組不會重複出現", () => {
    expect(resolveDependencies(["core", "blog", "blog", "contact-form"])).toEqual(["core", "blog", "contact-form"]);
  });

  it("偵測循環依賴並說明路徑", () => {
    const reg: Registry = new Map([
      ["a", fake("a", ["b"])],
      ["b", fake("b", ["c"])],
      ["c", fake("c", ["a"])],
    ]);
    expect(() => resolveDependencies(["a"], reg)).toThrow(DependencyError);
    expect(() => resolveDependencies(["a"], reg)).toThrow(/a → b → c → a/);
  });

  it("未知模組被拒", () => {
    expect(() => resolveDependencies(["nope"])).toThrow(/未知模組/);
  });
});

describe("checkDisable", () => {
  it("被其他已啟用模組依賴時拒絕並列出依賴者", () => {
    const msg = checkDisable("sections-basic", ["core", "sections-basic", "portfolio"]);
    expect(msg).toMatch(/portfolio/);
  });
  it("鎖定模組 core 不能停用", () => {
    expect(checkDisable("core", ["core"])).toMatch(/必備/);
  });
  it("沒人依賴時可以停用", () => {
    expect(checkDisable("blog", ["core", "blog", "sections-basic"])).toBeNull();
  });
  it("所有內建模組的依賴都存在且無循環", () => {
    expect(() => resolveDependencies([...registry.keys()])).not.toThrow();
  });
});
