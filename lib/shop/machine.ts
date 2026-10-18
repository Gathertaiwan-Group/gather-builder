import type { OrderStatus } from "../store/types";

/**
 * 訂單狀態機：所有狀態轉換都要經過這裡，不合法的轉換一律拒絕。
 *
 *   pending_payment ──付款（notify 回查／線下標記）──► paid ──出貨──► fulfilled
 *          │                                         │
 *          └──取消／逾期未付──► cancelled ◄──取消（需人工退款）┘
 *
 * fulfilled、cancelled 是終點（退貨／退款屬於下一批金流後台功能）。
 * 實際寫入一律是 DB 條件式更新（where status = from），併發時只有一個會成功。
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ["paid", "cancelled"],
  paid: ["fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: [],
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "待付款",
  paid: "已付款",
  fulfilled: "已出貨",
  cancelled: "已取消",
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 回傳可以轉到 to 的來源狀態（給條件式更新用） */
export function sourcesFor(to: OrderStatus): OrderStatus[] {
  return (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((s) => ORDER_TRANSITIONS[s].includes(to));
}

export class TransitionError extends Error {
  constructor(public from: OrderStatus, public to: OrderStatus) {
    super(`訂單狀態不能從「${ORDER_STATUS_LABEL[from]}」改成「${ORDER_STATUS_LABEL[to]}」`);
    this.name = "TransitionError";
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}
