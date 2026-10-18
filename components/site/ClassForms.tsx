import { moduleActive, moduleConfig, type LoadedSite } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { paymentAvailability, shopSettingsSchema, type ShopSettings } from "@/lib/services/shop";
import type { MemberRow } from "@/lib/store/types";

/** 活動／預約／課程表單共用的小元件（server component，表單直接 POST，不需要前端 JS） */

export function Flash({ sp }: { sp?: { ok?: string; err?: string } }) {
  return (
    <>
      {sp?.ok && (
        <p role="status" className="gb-card mb-4 p-3 text-sm" data-gb="ok">
          {sp.ok}
        </p>
      )}
      {sp?.err && (
        <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">
          {sp.err}
        </p>
      )}
    </>
  );
}

export function ContactFields({ member, prefix = "" }: { member: MemberRow | null; prefix?: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <label className="flex flex-col gap-1 text-sm font-medium">
        姓名
        <input className="gb-input" name={`${prefix}name`} required maxLength={80} autoComplete="name" defaultValue={member?.name ?? ""} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Email
        <input className="gb-input" name={`${prefix}email`} type="email" required maxLength={200} autoComplete="email" defaultValue={member?.email ?? ""} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        電話
        <input className="gb-input" name={`${prefix}phone`} type="tel" required minLength={6} maxLength={40} autoComplete="tel" defaultValue={member?.phone ?? ""} />
      </label>
    </div>
  );
}

export interface PayOptions {
  offline: boolean;
  offlineInstructions: string | null;
  pchomepay: boolean;
  sandbox: boolean;
  coupons: boolean;
  /** 第七批：其他已驗證的線上金流 */
  others?: { provider: string; label: string; sandbox: boolean }[];
}

/** 付款方式可用性：讀「目前顯示的快照」的 shop 設定；sandbox 只在預覽模式（同結帳頁 H1 規則） */
export async function payOptionsFor(site: LoadedSite): Promise<PayOptions | null> {
  if (!moduleActive(site, "shop")) return null;
  const parsed = shopSettingsSchema.safeParse(moduleConfig(site, "shop"));
  const settings = (parsed.success ? parsed.data : {}) as ShopSettings;
  const a = await paymentAvailability(getStore(), site.tenant, settings, { allowSandbox: site.mode === "preview" });
  return { offline: a.offline, offlineInstructions: a.offlineInstructions, pchomepay: a.pchomepay, sandbox: a.pchomepaySandbox && a.pchomepay, coupons: moduleActive(site, "coupons"), others: a.online.filter((o) => o.provider !== "pchomepay") };
}

export function PaymentFields({ pay }: { pay: PayOptions }) {
  const first = pay.offline ? "offline" : pay.pchomepay ? "pchomepay" : (pay.others?.[0]?.provider ?? "pchomepay");
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 text-sm">
      <legend className="mb-1 font-medium">付款方式</legend>
      {pay.offline && (
        <label className="flex items-start gap-2">
          <input type="radio" name="paymentMethod" value="offline" defaultChecked={first === "offline"} />
          <span>
            線下匯款{pay.offlineInstructions && <span className="gb-muted block text-xs">{pay.offlineInstructions}</span>}
          </span>
        </label>
      )}
      {pay.pchomepay && (
        <label className="flex items-center gap-2">
          <input type="radio" name="paymentMethod" value="pchomepay" defaultChecked={first === "pchomepay"} />
          線上刷卡（PChomePay）{pay.sandbox && <span className="text-xs text-amber-700">［測試環境］</span>}
        </label>
      )}
      {(pay.others ?? []).map((o) => (
        <label key={o.provider} className="flex items-center gap-2">
          <input type="radio" name="paymentMethod" value={o.provider} defaultChecked={first === o.provider} />
          線上付款（{o.label}）{o.sandbox && <span className="text-xs text-amber-700">［測試環境］</span>}
        </label>
      ))}
      {pay.coupons && (
        <label className="flex flex-col gap-1 font-medium">
          折扣碼（選填）
          <input className="gb-input" name="couponCode" maxLength={32} autoComplete="off" />
        </label>
      )}
    </fieldset>
  );
}

export const canPay = (p: PayOptions | null) => !!p && (p.offline || p.pchomepay || (p.others?.length ?? 0) > 0);
