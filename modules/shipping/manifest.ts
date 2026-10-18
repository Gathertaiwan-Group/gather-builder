import { z } from "zod";
import type { ModuleManifest } from "../types";
import { ALL_CVS_SUBTYPES, HOME_SUBTYPES } from "@/lib/shipping/ecpay";

const method = z
  .object({
    /** 方法代號（小寫英數、- _），結帳時用它選 */
    id: z.string().regex(/^[a-z0-9_-]{2,32}$/, { message: "id 需為 2–32 碼小寫英數或 - _" }),
    /** cvs 超商取貨／home 宅配／pickup 自取／manual 手動出貨（店主自填追蹤號） */
    type: z.enum(["cvs", "home", "pickup", "manual"]),
    /** ecpay＝綠界物流；manual＝店主自己寄（自取、手動出貨一律 manual） */
    provider: z.enum(["ecpay", "manual"]).default("manual"),
    /** 綠界物流子類型：超商 UNIMARTC2C／FAMIC2C／HILIFEC2C／OKMARTC2C（C2C）或 UNIMART／FAMI／HILIFE（B2C）；宅配 TCAT／POST */
    subType: z.string().optional(),
    label: z.string().trim().min(1).max(40),
    /** 運費（新台幣整數） */
    fee: z.number().int().min(0).max(10000),
    /** 這個方式的滿額免運門檻（小計 ≥ 門檻運費 0） */
    freeThreshold: z.number().int().min(0).max(10_000_000).optional(),
    /** 給客人看的說明（例如自取地址、營業時間） */
    instructions: z.string().trim().max(300).optional(),
  })
  .strict();

/** 物流設定（configure_module，進草稿、發布後生效）。綠界憑證不在這裡：只能從平台後台「物流」分頁輸入。 */
export const shippingSettings = z
  .object({
    methods: z.array(method).min(1, { message: "至少要設定一種運送方式" }).max(12),
    /** 寄件人（使用綠界物流時必填）：姓名同收件人規則、手機 09 開頭 10 碼 */
    sender: z
      .object({
        name: z.string().trim().min(2).max(10),
        cellPhone: z.string().regex(/^09\d{8}$/, { message: "寄件人手機需為 09 開頭 10 碼" }),
        zipCode: z.string().regex(/^\d{3,6}$/).optional(),
        address: z.string().trim().min(6).max(60).optional(),
      })
      .strict()
      .optional(),
    /** 托運單上的商品名稱（不填用「網路商品」） */
    goodsName: z.string().trim().max(25).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    s.methods.forEach((m, i) => {
      if (ids.has(m.id)) ctx.addIssue({ code: "custom", path: ["methods", i, "id"], message: `運送方式 id「${m.id}」重複` });
      ids.add(m.id);
      if (m.type === "cvs") {
        if (m.provider !== "ecpay") ctx.addIssue({ code: "custom", path: ["methods", i, "provider"], message: "超商取貨必須使用綠界物流（provider: ecpay）" });
        if (!m.subType || !ALL_CVS_SUBTYPES.includes(m.subType)) ctx.addIssue({ code: "custom", path: ["methods", i, "subType"], message: `超商子類型需為 ${ALL_CVS_SUBTYPES.join("／")}` });
      }
      if (m.type === "home" && m.provider === "ecpay" && !(HOME_SUBTYPES as readonly string[]).includes(m.subType ?? "")) {
        ctx.addIssue({ code: "custom", path: ["methods", i, "subType"], message: "綠界宅配子類型需為 TCAT（黑貓）或 POST（中華郵政）" });
      }
      if ((m.type === "pickup" || m.type === "manual") && m.provider !== "manual") ctx.addIssue({ code: "custom", path: ["methods", i, "provider"], message: "自取與手動出貨的 provider 必須是 manual" });
    });
    const usesEcpay = s.methods.some((m) => m.provider === "ecpay");
    if (usesEcpay && !s.sender) ctx.addIssue({ code: "custom", path: ["sender"], message: "使用綠界物流時必須設定寄件人（sender）" });
    if (s.methods.some((m) => m.provider === "ecpay" && m.type === "home") && (!s.sender?.zipCode || !s.sender?.address)) {
      ctx.addIssue({ code: "custom", path: ["sender"], message: "綠界宅配需要寄件人郵遞區號與地址" });
    }
  });
export type ShippingSettings = z.output<typeof shippingSettings>;
export type ShippingMethod = ShippingSettings["methods"][number];

export const manifest: ModuleManifest = {
  id: "shipping",
  name: "物流",
  description:
    "運送方式（超商取貨 7-11／全家／萊爾富／OK、宅配、自取、手動出貨），各自運費與滿額免運，server 端計價。綠界物流：結帳導到電子地圖選門市、付款後由店主建立物流單（create_shipment confirm:true）、物流狀態自動回寫（驗 CheckMacValue）。會員中心與訂單頁顯示物流狀態與追蹤號。🔴 綠界憑證只能由平台擁有者在後台輸入。",
  category: "commerce",
  priceSetup: 8000,
  priceMonthly: 500,
  requires: ["shop"],
  settingsSchema: shippingSettings,
  sectionTypes: [],
  adminPages: [{ path: "shipping", label: "物流" }],
  mcpTools: ["get_shipping_setup_status", "create_shipment", "get_shipment", "list_shipments"],
};
