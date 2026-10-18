"use client";

import { useState } from "react";

export interface InvoiceOptions {
  mobile: boolean;
  certificate: boolean;
  donation: boolean;
  b2b: boolean;
  defaultLoveCode: string | null;
}

/** 結帳頁的發票欄位（格式在 server 端 zod 驗證；這裡的 pattern 只是即時提示） */
export function InvoiceFields({ options }: { options: InvoiceOptions }) {
  const [type, setType] = useState<"member" | "mobile" | "certificate" | "donation" | "b2b">("member");
  const radio = (value: typeof type, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="radio" name="invoiceType" value={value} checked={type === value} onChange={() => setType(value)} /> {label}
    </label>
  );
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-gb="invoice-fields">
      <legend className="mb-2 text-lg font-bold">電子發票</legend>
      {radio("member", "會員載具（發票寄到 Email）")}
      {options.mobile && radio("mobile", "手機條碼載具")}
      {options.certificate && radio("certificate", "自然人憑證載具")}
      {options.donation && radio("donation", "捐贈發票")}
      {options.b2b && radio("b2b", "公司戶（三聯式，需統編）")}
      {(type === "mobile" || type === "certificate") && (
        <label className="flex flex-col gap-1 text-sm font-medium">
          {type === "mobile" ? "手機條碼（/ 開頭共 8 碼）" : "自然人憑證條碼（2 碼英文＋14 碼數字）"}
          <input
            name="invoiceCarrier"
            required
            className="gb-input"
            autoComplete="off"
            pattern={type === "mobile" ? "/[0-9A-Za-z.+\\-]{7}" : "[A-Za-z]{2}[0-9]{14}"}
            maxLength={type === "mobile" ? 8 : 16}
            style={{ textTransform: "uppercase" }}
          />
        </label>
      )}
      {type === "donation" && (
        <label className="flex flex-col gap-1 text-sm font-medium">
          愛心碼（3–7 碼數字）
          <input name="invoiceLoveCode" required className="gb-input" inputMode="numeric" pattern="[0-9]{3,7}" maxLength={7} defaultValue={options.defaultLoveCode ?? ""} />
        </label>
      )}
      {type === "b2b" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            統一編號
            <input name="invoiceTaxId" required className="gb-input" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            公司抬頭
            <input name="invoiceTitle" required className="gb-input" maxLength={60} />
          </label>
        </div>
      )}
    </fieldset>
  );
}
