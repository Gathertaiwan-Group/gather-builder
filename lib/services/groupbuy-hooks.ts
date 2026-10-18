import { merchandiseNet } from "../loyalty/rules";
import type { OrderRow, Store, TenantRow } from "../store/types";
import { registerOrderHooks, type HookDeps } from "./order-hooks";

/**
 * 團主分潤（第八批）：付款成功那一次記 earn、取消／退款記 reverse。只增不改（builder_group_buy_commissions，unique(order, kind)）。
 * 分潤基數＝商品實付淨額（小計 − 折扣碼 − 等級折扣 − 點數折抵；與 KOL 分潤、賺點一致，merchandiseNet）。
 * 分潤設定用「下單當下」的快照（builder_group_buy_orders.commission_*），之後改設定不影響已下的單。
 * 🔴 葉節點：只依賴 order-hooks（沒有 orders／shop），orders.ts 以 side-effect import 註冊，避免循環 import。
 */
export function commissionFor(base: number, kind: "percent" | "fixed" | null, value: number | null): number {
  if (!kind || !value || value <= 0 || base <= 0) return 0;
  return kind === "percent" ? Math.floor((base * value) / 10000) : Math.min(value, base);
}

export async function onGroupBuyOrderPaid(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  if (!order.group_buy_id || !order.group_buy_leader_id || order.payment_sandbox) return;
  const gbo = await deps.store.getGroupBuyOrder(tenant.id, order.id);
  if (!gbo || !gbo.leader_id) return;
  const base = merchandiseNet(order);
  const amount = commissionFor(base, gbo.commission_kind, gbo.commission_value);
  if (amount <= 0) return;
  if (await deps.store.insertGroupBuyCommission({ tenant_id: tenant.id, group_buy_id: gbo.group_buy_id, leader_id: gbo.leader_id, order_id: order.id, kind: "earn", amount, base })) {
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:group-buy", action: "group_buy.commission", payload: { orderNo: order.order_no, leaderId: gbo.leader_id, base, amount } });
  }
}

export async function onGroupBuyOrderCancelled(store: Store, tenant: TenantRow, order: OrderRow) {
  if (!order.group_buy_id) return;
  const earned = (await store.listGroupBuyCommissions(tenant.id, { orderIds: [order.id] })).find((c) => c.kind === "earn");
  if (!earned) return;
  if (await store.insertGroupBuyCommission({ tenant_id: tenant.id, group_buy_id: earned.group_buy_id, leader_id: earned.leader_id, order_id: order.id, kind: "reverse", amount: -earned.amount, base: earned.base })) {
    await store.insertAudit({ tenant_id: tenant.id, actor: "system:group-buy", action: "group_buy.commission_reverse", payload: { orderNo: order.order_no, amount: -earned.amount } });
  }
}

registerOrderHooks({ name: "group-buy", paid: onGroupBuyOrderPaid, cancelled: onGroupBuyOrderCancelled });
