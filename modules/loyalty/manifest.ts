import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText, text } from "@/lib/validators";

export const tierSchema = z
  .object({
    /** 等級代碼（比對鍵，不翻譯、不可重複），例如 silver */
    id: z.string().trim().regex(/^[a-z0-9-]{1,20}$/, { message: "等級代碼需為 1–20 字小寫英數與連字號" }),
    name: text(30),
    /** 期間內（tierWindowMonths）已付款消費達到多少元升到這一級 */
    minSpend: z.number().int().min(0).max(100_000_000),
    /** 賺點倍率（1 ＝ 一般；1.5 ＝ 1.5 倍） */
    multiplier: z.number().min(1).max(10).default(1),
    /** 等級專屬折扣（商品金額 %，0＝無） */
    discountPercent: z.number().int().min(0).max(50).default(0),
    perks: optText(200),
  })
  .strict();

/** 點數＋等級設定（configure_module，進草稿、發布後生效）。全部有預設值，{} 即可啟用 */
export const loyaltySettings = z
  .object({
    /** 每消費多少元得 1 點（商品淨額，不含運費），預設 100 */
    earnPerAmount: z.number().int().min(1).max(100_000).optional(),
    /** 1 點折抵多少元，預設 1 */
    pointValue: z.number().int().min(1).max(1000).optional(),
    /** 單筆最多折抵商品金額的幾 %（預設 50） */
    maxRedeemPercent: z.number().int().min(1).max(100).optional(),
    /** false＝只累積不開放折抵 */
    redeemEnabled: z.boolean().optional(),
    /** 每筆賺到的點數幾天後到期（預設 365） */
    pointsExpireDays: z.number().int().min(1).max(3650).optional(),
    /** 等級依「最近幾個月」的消費計算（預設 12；0＝累計全部） */
    tierWindowMonths: z.number().int().min(0).max(60).optional(),
    /** 店主手動調整（adjust_points）單次上限（點，預設 5,000）——審查 M3 */
    adjustMaxPerCall: z.number().int().min(1).max(1_000_000).optional(),
    /** 店主手動調整每日上限（全站加總、台北日，預設 20,000 點） */
    adjustMaxPerDay: z.number().int().min(1).max(10_000_000).optional(),
    /** 等級（依 minSpend 由低到高；沒達到任何一級＝一般會員） */
    tiers: z
      .array(tierSchema)
      .max(10)
      .optional()
      .superRefine((ts, c) => {
        if (!ts) return;
        const ids = new Set<string>();
        for (const t of ts) {
          if (ids.has(t.id)) c.addIssue({ code: "custom", message: `等級代碼重複：${t.id}` });
          ids.add(t.id);
        }
      }),
  })
  .strict();
export type LoyaltySettings = z.output<typeof loyaltySettings>;
export type Tier = z.output<typeof tierSchema>;

export const loyaltyTiersProps = z
  .object({
    heading: optText(120),
    intro: optText(400),
    showEarnRule: z.boolean().default(true),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "loyalty",
  name: "會員點數＋等級",
  description:
    "消費賺點（每 X 元 1 點、等級倍率，付款成功那一次入帳、取消沖回）、結帳用點數折抵（1 點＝N 元、單筆上限比例，下單交易內原子扣點）、點數依到期日 FIFO 到期（預設 365 天）、依期間消費自動升降級（等級折扣與賺點倍率）。會員中心顯示點數、到期明細與等級。點數帳本只增不改。",
  category: "commerce",
  priceSetup: 12000,
  priceMonthly: 800,
  requires: ["members", "shop"],
  settingsSchema: loyaltySettings,
  sectionTypes: [
    {
      type: "loyalty_tiers",
      label: "會員等級與點數說明",
      description: "列出會員等級（門檻、折扣、賺點倍率）與點數規則。",
      schema: loyaltyTiersProps,
      example: { heading: "會員制度", showEarnRule: true },
    },
  ],
  adminPages: [{ path: "loyalty", label: "會員經營" }],
  mcpTools: ["get_member_points", "adjust_points", "list_tiers", "update_tiers"],
};
