import type { MemberRow, Store, TenantRow } from "../store/types";
import type { LoyaltySettings } from "@/modules/loyalty/manifest";
import { ServiceError, activeModuleIds, moduleStates } from "./context";
import { publishedModuleSettings } from "./members";
import { DEFAULT_POINT_VALUE, maxRedeemablePoints, tierDiscount } from "../loyalty/rules";
import { currentTier } from "./loyalty";

/**
 * 結帳的會員折抵（server 計價，前端只送「想用多少點／多少儲值金」）：
 * 1. 等級折扣：商品金額（扣折扣碼後）× 等級 %；
 * 2. 點數折抵：最多「商品金額（扣等級折扣後）× maxRedeemPercent」，1 點＝pointValue 元，超過上限自動降到上限；
 * 3. 儲值金：最多付到剩下的全部（含運費）。
 * 試算（strict=false）只回訊息；下單（strict=true）點數／儲值金不足直接擋。實際扣用在 builder_place_order 同一交易（併發不超用）。
 * total ＝ 商品 − 等級折扣 − 點數折抵 ＋ 運費 − 儲值金。total 為 0 → 付款方式改為 credit（不經金流）。
 */
export interface CreditsResult {
  tierId: string | null;
  tierName: string | null;
  tierDiscount: number;
  pointsRedeemed: number;
  pointsDiscount: number;
  pointsAvailable: number;
  maxPoints: number;
  pointValue: number;
  walletPaid: number;
  walletAvailable: number;
  total: number;
  messages: string[];
}

export async function resolveCredits(
  store: Store,
  tenant: TenantRow,
  input: { member: MemberRow | null; merchandise: number; shippingFee: number; pointsToUse?: number | null; walletToUse?: number | null; strict?: boolean },
): Promise<CreditsResult> {
  const strict = input.strict !== false;
  const active = activeModuleIds(await moduleStates({ store }, tenant.id));
  const out: CreditsResult = { tierId: null, tierName: null, tierDiscount: 0, pointsRedeemed: 0, pointsDiscount: 0, pointsAvailable: 0, maxPoints: 0, pointValue: DEFAULT_POINT_VALUE, walletPaid: 0, walletAvailable: 0, total: input.merchandise + input.shippingFee, messages: [] };
  const wantPoints = Math.max(0, Math.floor(input.pointsToUse ?? 0));
  const wantWallet = Math.max(0, Math.floor(input.walletToUse ?? 0));
  const member = input.member;
  if (!member) {
    if (wantPoints || wantWallet) {
      if (strict) throw new ServiceError("unauthorized", "使用點數或儲值金需要先登入會員");
      out.messages.push("使用點數或儲值金需要先登入會員");
    }
    return out;
  }
  let merch = Math.max(0, input.merchandise);
  if (active.has("loyalty")) {
    const s = (await publishedModuleSettings(store, tenant, "loyalty")) as LoyaltySettings;
    const tier = await currentTier(store, tenant, member, s);
    if (tier) {
      out.tierId = tier.id;
      out.tierName = tier.name;
      out.tierDiscount = tierDiscount(merch, tier);
      merch -= out.tierDiscount;
    }
    out.pointValue = s.pointValue ?? DEFAULT_POINT_VALUE;
    const st = await store.creditState("points", tenant.id, member.id);
    out.pointsAvailable = st.available;
    out.maxPoints = Math.min(maxRedeemablePoints(merch, s), st.available);
    if (wantPoints) {
      if (s.redeemEnabled === false) {
        if (strict) throw new ServiceError("invalid", "此商店目前不開放點數折抵");
        out.messages.push("此商店目前不開放點數折抵");
      } else if (wantPoints > st.available) {
        if (strict) throw new ServiceError("conflict", `點數不足（可用 ${st.available} 點）`);
        out.messages.push(`點數不足（可用 ${st.available} 點）`);
      } else {
        const use = Math.min(wantPoints, out.maxPoints);
        if (use < wantPoints) out.messages.push(`這筆最多可折抵 ${out.maxPoints} 點（商品金額的上限比例）`);
        out.pointsRedeemed = use;
        out.pointsDiscount = Math.min(merch, use * out.pointValue);
        merch -= out.pointsDiscount;
      }
    }
  } else if (wantPoints) {
    if (strict) throw new ServiceError("invalid", "此商店未開放點數折抵");
    out.messages.push("此商店未開放點數折抵");
  }
  let due = merch + input.shippingFee;
  if (active.has("stored-value")) {
    const st = await store.creditState("wallet", tenant.id, member.id);
    out.walletAvailable = st.available;
    if (wantWallet) {
      if (wantWallet > st.available) {
        if (strict) throw new ServiceError("conflict", `儲值金餘額不足（可用 NT$${st.available}）`);
        out.messages.push(`儲值金餘額不足（可用 NT$${st.available}）`);
      } else {
        out.walletPaid = Math.min(wantWallet, due);
        due -= out.walletPaid;
      }
    }
  } else if (wantWallet) {
    if (strict) throw new ServiceError("invalid", "此商店未開放儲值金付款");
    out.messages.push("此商店未開放儲值金付款");
  }
  out.total = due;
  return out;
}
