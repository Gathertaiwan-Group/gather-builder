import type { MemberRow, Store, TenantRow } from "../store/types";
import { ServiceError, activeModuleIds, moduleStates } from "./context";
import { checkCoupon, couponUserKey } from "./coupons";
import { sameEmail } from "../email-normalize";

export interface PromotionResult {
  discount: number;
  coupon: { id: string; code: string; user_key: string } | null;
  couponMessage: string | null;
  referralCode: string | null;
}

/**
 * 結帳的優惠：第一版只允許一張折扣碼（不與其他優惠併用）＋記錄推薦碼。
 * 折扣只算在商品小計（不含運費）。下單時 builder_place_order 會在同一交易原子扣次數（併發不超用）。
 * strict=true（下單）時折扣碼無效直接擋；false（試算）時只回訊息。
 */
export async function applyPromotions(
  store: Store,
  tenant: TenantRow,
  input: { subtotal: number; couponCode?: string | null; referralCode?: string | null; member: MemberRow | null; email: string; strict?: boolean },
): Promise<PromotionResult> {
  const strict = input.strict !== false;
  const active = activeModuleIds(await moduleStates({ store }, tenant.id));
  let discount = 0;
  let coupon: PromotionResult["coupon"] = null;
  let couponMessage: string | null = null;
  const code = input.couponCode?.trim();
  if (code) {
    if (!active.has("coupons")) {
      if (strict) throw new ServiceError("invalid", "此商店未開放折扣碼");
      couponMessage = "此商店未開放折扣碼";
    } else {
      const r = await checkCoupon(store, tenant, { code, subtotal: input.subtotal, member: input.member, email: input.email || "guest@invalid" });
      if (!r.ok) {
        if (strict) throw new ServiceError("invalid", `折扣碼無法使用：${r.message}`);
        couponMessage = r.message;
      } else {
        discount = r.discount;
        coupon = { id: r.coupon.id, code: r.coupon.code, user_key: couponUserKey(input.member, input.email) };
        couponMessage = `已套用 ${r.coupon.code}`;
      }
    }
  }
  let referralCode: string | null = null;
  const ref = input.referralCode?.trim().toUpperCase();
  if (ref && active.has("referral") && /^[A-Z0-9]{4,16}$/.test(ref)) {
    const rc = await store.getReferralCodeByCode(tenant.id, ref);
    // 不能自己推薦自己：推薦碼的主人＝目前會員，或 email 相同 → 忽略
    if (rc && rc.member_id !== input.member?.id) {
      const owner = await store.getMemberById(tenant.id, rc.member_id);
      // H-1：email 正規化比對（a+x@、gmail 加點視為本人）；下單會員帳號的 email 也要比
      if (owner && !sameEmail(owner.email, input.email) && !sameEmail(owner.email, input.member?.email)) referralCode = rc.code;
    }
  }
  return { discount, coupon, couponMessage, referralCode };
}
