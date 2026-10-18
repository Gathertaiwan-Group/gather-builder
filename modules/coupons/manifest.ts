import { z } from "zod";
import type { ModuleManifest } from "../types";

export const couponsSettings = z.object({}).strict();

export const manifest: ModuleManifest = {
  id: "coupons",
  name: "優惠券",
  description:
    "折扣碼：固定金額或百分比（百分比一定要設折抵上限）、最低消費、有效期間、總使用次數上限、每人（會員或 email）使用次數上限。第一版一張訂單只能用一張，不與其他優惠併用。折扣只算商品小計、由 server 計價；使用次數在下單的同一交易內原子扣減（併發不超用），取消／逾期冪等回補。客人在結帳頁輸入。",
  category: "commerce",
  priceSetup: 3000,
  priceMonthly: 300,
  requires: ["shop"],
  settingsSchema: couponsSettings,
  sectionTypes: [],
  adminPages: [{ path: "marketing", label: "行銷" }],
  mcpTools: ["create_coupon", "update_coupon", "list_coupons"],
};
