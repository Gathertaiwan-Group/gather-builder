import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const membersSettings = z
  .object({
    /** false = 關閉註冊（既有會員仍可登入） */
    allowRegistration: z.boolean().optional(),
  })
  .strict();

export const accountLinkProps = z
  .object({
    heading: optText(120),
    intro: optText(400),
    loginLabel: optText(30),
    registerLabel: optText(30),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "members",
  name: "會員系統",
  description:
    "網站自己的會員帳號：註冊、登入、登出、忘記／重設密碼、Email 驗證、會員中心（個人資料、我的訂單）。每個網站的會員分開存、分開登入（A 站帳號在 B 站不存在）。頁面固定在 /account。",
  category: "engagement",
  priceSetup: 8000,
  priceMonthly: 300,
  requires: ["core"],
  settingsSchema: membersSettings,
  sectionTypes: [
    {
      type: "account_cta",
      label: "會員登入／註冊入口",
      description: "引導訪客登入或註冊的區塊（已登入時顯示「前往會員中心」）。",
      schema: accountLinkProps,
      example: { heading: "加入會員", intro: "註冊會員，查詢訂單更方便。" },
    },
  ],
  adminPages: [{ path: "members", label: "會員" }],
  mcpTools: ["list_members", "get_member", "disable_member"],
};
