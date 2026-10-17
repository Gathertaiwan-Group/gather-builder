import { describe, expect, it } from "vitest";
import { validateSectionProps, allSectionTypes } from "@/modules/registry";

describe("區塊 props 驗證", () => {
  it("合法 hero 通過並套用預設值", () => {
    const r = validateSectionProps("hero", { heading: "嗨" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.props.align).toBe("center");
  });
  it("缺必填欄位被拒且指出欄位", () => {
    const r = validateSectionProps("hero", { subheading: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/heading/);
  });
  it("未知欄位被拒（strict）", () => {
    const r = validateSectionProps("cta", { heading: "a", buttonLabel: "b", buttonHref: "/x", script: "alert(1)" });
    expect(r.ok).toBe(false);
  });
  it("javascript: 連結被拒", () => {
    const r = validateSectionProps("cta", { heading: "a", buttonLabel: "b", buttonHref: "javascript:alert(1)" });
    expect(r.ok).toBe(false);
  });
  it("非 https 圖片被拒", () => {
    const r = validateSectionProps("gallery", { images: [{ src: "http://x.com/a.png", alt: "a" }] });
    expect(r.ok).toBe(false);
  });
  it("未知區塊類型被拒", () => {
    expect(validateSectionProps("marquee", {}).ok).toBe(false);
  });
  it("每個區塊的 example 都通過自己的 schema", () => {
    for (const { def } of allSectionTypes()) {
      const r = validateSectionProps(def.type, def.example);
      expect(r.ok, def.type).toBe(true);
    }
  });
});
