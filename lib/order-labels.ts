/** 前台顯示用的狀態文字（發票、物流） */
export const INVOICE_LABEL: Record<string, string> = {
  pending: "待開立",
  issuing: "開立中",
  issued: "已開立",
  failed: "開立中",
  voided: "已作廢",
  allowance: "已折讓",
};

export const SHIPMENT_LABEL: Record<string, string> = {
  created: "已建立出貨單",
  in_transit: "配送中",
  arrived: "已到店／待取件",
  delivered: "已取件／已送達",
  returned: "退回",
  failed: "出貨單建立失敗",
  cancelled: "已取消",
};
