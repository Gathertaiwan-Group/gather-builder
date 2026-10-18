"use client";

import { useEffect, useState } from "react";
import { readCart, writeCart, type CartLine } from "@/lib/shop/cart";

interface QuoteLine {
  productId: string;
  variantId: string | null;
  name: string;
  variantLabel: string | null;
  unitPrice: number;
  qty: number;
  lineTotal: number;
  stockAvailable: number | null;
}
interface Quote {
  lines: QuoteLine[];
  subtotal: number;
  shippingFee: number;
  total: number;
  problems: string[];
}

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

/**
 * 購物車（localStorage）＋結帳表單。顯示的價格來自 server 重新計價（/api/shop/quote）；
 * 送出時 server 會再算一次，前端的任何價格都不被採信。
 */
export function CheckoutClient(props: {
  slug: string;
  quoteUrl: string;
  action: string;
  shopHref: string;
  loginHref: string;
  member: { name: string; email: string; phone: string } | null;
  methods: { pchomepay: boolean; atm: boolean; offline: boolean; offlineInstructions: string | null; sandbox: boolean };
  minOnline: number;
  /** 預覽模式（網站主自己測試）才有：sandbox 金流只接受帶簽章的結帳 */
  previewToken?: string | null;
}) {
  const [cart, setCart] = useState<CartLine[] | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [method, setMethod] = useState<"pchomepay" | "offline">(props.methods.pchomepay ? "pchomepay" : "offline");
  const [payType, setPayType] = useState<"card" | "atm">("card");
  const [same, setSame] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const sync = () => setCart(readCart(props.slug));
    sync();
    window.addEventListener("gb-cart", sync);
    return () => window.removeEventListener("gb-cart", sync);
  }, [props.slug]);

  useEffect(() => {
    if (!cart) return;
    if (!cart.length) {
      setQuote(null);
      return;
    }
    let alive = true;
    fetch(props.quoteUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: cart.map(({ productId, variantId, qty }) => ({ productId, variantId, qty })) }) })
      .then(async (r) => {
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) throw new Error(j.error ?? "無法計算金額");
        setQuote(j as Quote);
        setError("");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "無法計算金額"));
    return () => {
      alive = false;
    };
  }, [cart, props.quoteUrl]);

  const setQty = (i: number, qty: number) => {
    if (!cart) return;
    const next = cart.map((l, j) => (j === i ? { ...l, qty: Math.max(1, Math.min(99, qty)) } : l));
    writeCart(props.slug, next);
  };
  const remove = (i: number) => cart && writeCart(props.slug, cart.filter((_, j) => j !== i));

  if (cart === null) return <p className="gb-muted">載入購物車…</p>;
  if (!cart.length) {
    return (
      <p>
        購物車是空的。<a href={props.shopHref}>去逛逛商品 →</a>
      </p>
    );
  }
  const noMethod = !props.methods.pchomepay && !props.methods.offline;
  const belowMin = method === "pchomepay" && !!quote && quote.total < props.minOnline;
  const m = props.member;

  return (
    <div className="flex flex-col gap-6">
      <div className="gb-card p-4 md:p-5" data-gb="cart">
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {cart.map((l, i) => {
            const q = quote?.lines.find((x) => x.productId === l.productId && (x.variantId ?? null) === (l.variantId ?? null));
            return (
              <li key={`${l.productId}-${l.variantId ?? ""}`} className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0 flex-1">
                  {q?.name ?? l.name}
                  {(q?.variantLabel ?? l.variantLabel) && <span className="gb-muted">（{q?.variantLabel ?? l.variantLabel}）</span>}
                  {q && <span className="gb-muted ml-2 text-sm">{twd(q.unitPrice)}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <input aria-label="數量" type="number" min={1} max={99} value={l.qty} onChange={(e) => setQty(i, Number(e.target.value) || 1)} className="gb-input" style={{ width: "5rem" }} />
                  <button type="button" onClick={() => remove(i)} className="text-sm underline" style={{ background: "none", border: 0, color: "var(--gb-text)", cursor: "pointer" }}>
                    移除
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        {quote && (
          <div className="mt-4 flex flex-col items-end gap-1 border-t pt-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }} data-gb="totals">
            <span>小計 {twd(quote.subtotal)}</span>
            <span>運費 {twd(quote.shippingFee)}</span>
            <strong className="text-lg">總計 {twd(quote.total)}</strong>
          </div>
        )}
        {quote?.problems.map((p, i) => (
          <p key={i} role="alert" className="m-0 mt-2 text-sm" style={{ color: "#b91c1c" }}>
            {p}
          </p>
        ))}
        {error && (
          <p role="alert" className="m-0 mt-2 text-sm" style={{ color: "#b91c1c" }}>
            {error}
          </p>
        )}
      </div>

      {noMethod ? (
        <p className="gb-card p-4">此商店尚未開放結帳（付款方式設定中），請稍後再試或直接聯絡店家。</p>
      ) : (
        <form method="post" action={props.action} className="gb-card flex flex-col gap-4 p-4 md:p-5" data-gb="checkout-form" onSubmit={() => setSubmitting(true)}>
          <input type="hidden" name="items" value={JSON.stringify(cart.map(({ productId, variantId, qty }) => ({ productId, variantId, qty })))} />
          {props.previewToken && <input type="hidden" name="preview" value={props.previewToken} />}
          {!m && (
            <p className="m-0 text-sm">
              已是會員？<a href={props.loginHref}>登入</a>後訂單會出現在會員中心。也可以直接以訪客身分結帳。
            </p>
          )}
          <h2 className="m-0 text-lg font-bold">訂購人</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              姓名
              <input name="contactName" required maxLength={80} className="gb-input" defaultValue={m?.name} autoComplete="name" />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Email
              <input name="contactEmail" type="email" required maxLength={200} className="gb-input" defaultValue={m?.email} autoComplete="email" />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              電話
              <input name="contactPhone" type="tel" required minLength={6} maxLength={40} className="gb-input" defaultValue={m?.phone} autoComplete="tel" />
            </label>
          </div>
          <h2 className="m-0 text-lg font-bold">收件資料</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="shipSame" checked={same} onChange={(e) => setSame(e.target.checked)} /> 收件人同訂購人
          </label>
          {!same && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm font-medium">
                收件人姓名
                <input name="shipName" required maxLength={80} className="gb-input" />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                收件人電話
                <input name="shipPhone" type="tel" required minLength={6} maxLength={40} className="gb-input" />
              </label>
            </div>
          )}
          <label className="flex flex-col gap-1 text-sm font-medium">
            收件地址
            <input name="shipAddress" required maxLength={300} className="gb-input" autoComplete="street-address" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            備註（選填）
            <textarea name="note" maxLength={500} rows={2} className="gb-input" />
          </label>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-lg font-bold">付款方式</legend>
            {props.methods.pchomepay && (
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="paymentMethod" value="pchomepay" checked={method === "pchomepay"} onChange={() => setMethod("pchomepay")} />
                線上付款（PChomePay 支付連）{props.methods.sandbox && <span className="gb-muted">［測試環境］</span>}
              </label>
            )}
            {method === "pchomepay" && props.methods.atm && (
              <div className="ml-6 flex flex-col gap-1 text-sm" data-gb="pay-type">
                <label className="flex items-center gap-2">
                  <input type="radio" name="pchomepayType" value="card" checked={payType === "card"} onChange={() => setPayType("card")} /> 信用卡
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="pchomepayType" value="atm" checked={payType === "atm"} onChange={() => setPayType("atm")} /> ATM 轉帳
                </label>
              </div>
            )}
            {props.methods.offline && (
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="paymentMethod" value="offline" checked={method === "offline"} onChange={() => setMethod("offline")} />
                線下匯款
              </label>
            )}
            {method === "offline" && props.methods.offlineInstructions && <p className="gb-muted m-0 whitespace-pre-line text-sm">{props.methods.offlineInstructions}</p>}
            {belowMin && (
              <p role="alert" className="m-0 text-sm" style={{ color: "#b91c1c" }}>
                線上付款最低金額為 NT${props.minOnline}，請改用其他付款方式或加購商品。
              </p>
            )}
          </fieldset>
          <button type="submit" className="gb-btn self-start" disabled={submitting || !quote || quote.problems.length > 0 || belowMin}>
            {submitting ? "處理中…" : method === "pchomepay" ? "前往付款" : "送出訂單"}
          </button>
        </form>
      )}
    </div>
  );
}
