import { describe, expect, it } from "vitest";
import { allSectionTypes } from "@/modules/registry";
import { SECTION_RENDERERS } from "@/modules/renderers";

describe("區塊渲染註冊", () => {
  it("每個 manifest 宣告的區塊類型都有渲染元件，且沒有多餘的", () => {
    const declared = allSectionTypes().map((s) => s.def.type).sort();
    expect(Object.keys(SECTION_RENDERERS).sort()).toEqual(declared);
  });
  it("區塊類型全平台唯一", () => {
    const types = allSectionTypes().map((s) => s.def.type);
    expect(new Set(types).size).toBe(types.length);
  });
});
