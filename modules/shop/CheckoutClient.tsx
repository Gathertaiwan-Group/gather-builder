"use client";

import { useEffect, useState } from "react";
import { readCart, writeCart, type CartLine } from "@/lib/shop/cart";
import { InvoiceFields, type InvoiceOptions } from "@/modules/invoice/InvoiceFields";

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
  shippingSelected?: boolean;
  discount?: number;
  couponMessage?: string | null;
  tierName?: string | null;
  tierDiscount?: number;
  pointsRedeemed?: number;
  pointsDiscount?: number;
  pointsAvailable?: number;
  maxPoints?: number;
  pointValue?: number;
  walletPaid?: number;
  walletAvailable?: number;
  creditMessages?: string[];
  total: number;
  problems: string[];
}

export interface CheckoutShippingMethod {
  id: string;
  type: "cvs" | "home" | "pickup" | "manual";
  label: string;
  fee: number;
  freeThreshold: number | null;
  instructions: string | null;
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
  /** invoice 模組啟用時才有 */
  invoiceOptions?: InvoiceOptions | null;
  /** shipping 模組啟用時才有（null＝用商店固定運費） */
  shippingMethods?: CheckoutShippingMethod[] | null;
  /** 從電子地圖回來、且屬於這個瀏覽器的選店 */
  cvsSelection?: { id: string; methodId: string; store: { name: string; address: string } } | null;
  cvsStartAction?: string;
  /** coupons 模組啟用時顯示折扣碼欄位 */
  couponsEnabled?: boolean;
  /** 已登入會員且 loyalty／stored-value 啟用時：可用點數／儲值金折抵 */
  credits?: { points: boolean; wallet: boolean } | null;
}) {
  const [cart, setCart] = useState<CartLine[] | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [method, setMethod] = useState<"pchomepay" | "offline">(props.methods.pchomepay ? "pchomepay" : "offline");
  const [payType, setPayType] = useState<"card" | "atm">("card");
  const methods = props.shippingMethods ?? null;
  const [shipId, setShipId] = useState<string>(props.cvsSelection?.methodId ?? (methods && methods.length === 1 ? methods[0]!.id : ""));
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState("");
  const [pointsInput, setPointsInput] = useState("");
  const [points, setPoints] = useState(0);
  const [walletInput, setWalletInput] = useState("");
  const [wallet, setWallet] = useState(0);
  const draftKey = `gb-checkout-${props.slug}`;
  const shipMethod = methods?.find((m) => m.id === shipId) ?? null;
  const cvsReady = shipMethod?.type !== "cvs" || props.cvsSelection?.methodId === shipMethod.id;

  // 預覽模式（網站主測試）：從電子地圖回來時網址沒有預覽簽章，用 sessionStorage 補回
  useEffect(() => {
    try {
      const k = `gb-preview-${props.slug}`;
      if (props.previewToken) sessionStorage.setItem(k, props.previewToken);
      else {
        const u = new URL(window.location.href);
        const saved = sessionStorage.getItem(k);
        if (saved && u.searchParams.has("cvs") && !u.searchParams.has("preview")) {
          u.searchParams.set("preview", saved);
          window.location.replace(u.toString());
        }
      }
    } catch {
      /* 忽略 */
    }
  }, [props.slug, props.previewToken]);

  // 去電子地圖前把填到一半的資料存起來，回來時填回（跨頁導轉會清空表單）
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, string>;
      const form = document.querySelector<HTMLFormElement>('form[data-gb="checkout-form"]');
      for (const [k, v] of Object.entries(saved)) {
        const el = form?.elements.namedItem(k);
        if (el instanceof HTMLInputElement && el.type !== "radio" && el.type !== "checkbox" && el.type !== "hidden") el.value = v;
        if (el instanceof HTMLTextAreaElement) el.value = v;
      }
      if (saved.__coupon) {
        setCoupon(saved.__coupon);
        setCouponInput(saved.__coupon);
      }
    } catch {
      /* 忽略 */
    }
  }, [draftKey, cart]);
  const saveDraft = () => {
    try {
      const form = document.querySelector<HTMLFormElement>('form[data-gb="checkout-form"]');
      const data: Record<string, string> = { __coupon: coupon };
      if (form) for (const [k, v] of new FormData(form).entries()) if (typeof v === "string" && k !== "items") data[k] = v;
      sessionStorage.setItem(draftKey, JSON.stringify(data));
    } catch {
      /* 忽略 */
    }
  };
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
    fetch(props.quoteUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map(({ productId, variantId, qty }) => ({ productId, variantId, qty })), shippingMethodId: shipId || undefined, couponCode: coupon || undefined, preview: props.previewToken ?? undefined, pointsToUse: points || undefined, walletToUse: wallet || undefined }),
    })
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
  }, [cart, props.quoteUrl, shipId, coupon, props.previewToken, points, wallet]);

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
  const usedCredits = !!quote && ((quote.pointsRedeemed ?? 0) > 0 || (quote.walletPaid ?? 0) > 0);
  const fullyCovered = usedCredits && quote!.total === 0;
  const belowMin = !fullyCovered && method === "pchomepay" && !!quote && quote.total < props.minOnline;
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
            <span>
              運費 {twd(quote.shippingFee)}
              {quote.shippingSelected === false && <span className="gb-muted">（選擇運送方式後確定）</span>}
            </span>
            {!!quote.discount && <span data-gb="discount">折扣 −{twd(quote.discount)}</span>}
            {!!quote.tierDiscount && <span data-gb="tier-discount">{quote.tierName ?? "會員"}折扣 −{twd(quote.tierDiscount)}</span>}
            {!!quote.pointsDiscount && <span data-gb="points-discount">點數折抵 {quote.pointsRedeemed} 點 −{twd(quote.pointsDiscount)}</span>}
            {!!quote.walletPaid && <span data-gb="wallet-paid">儲值金 −{twd(quote.walletPaid)}</span>}
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
        <form method="post" action={props.action} className="gb-card flex flex-col gap-4 p-4 md:p-5" data-gb="checkout-form" onSubmit={(e) => {
            const sub = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            if (sub?.dataset.gb === "cvs-pick") return; // 去選門市不鎖按鈕
            try {
              sessionStorage.removeItem(draftKey);
            } catch {
              /* 忽略 */
            }
            setSubmitting(true);
          }}>
          <input type="hidden" name="items" value={JSON.stringify(cart.map(({ productId, variantId, qty }) => ({ productId, variantId, qty })))} />
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
          {methods && (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-gb="shipping-methods">
              <legend className="mb-2 text-lg font-bold">運送方式</legend>
              <input type="hidden" name="shippingMethodId" value={shipId} />
              {methods.map((m) => (
                <label key={m.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <input type="radio" name="__ship" value={m.id} checked={shipId === m.id} onChange={() => setShipId(m.id)} />
                  {m.label} · {m.fee === 0 ? "免運" : twd(m.fee)}
                  {m.freeThreshold !== null && m.fee > 0 && <span className="gb-muted">（滿 {twd(m.freeThreshold)} 免運）</span>}
                </label>
              ))}
              {shipMethod?.instructions && <p className="gb-muted m-0 whitespace-pre-line text-sm">{shipMethod.instructions}</p>}
              {shipMethod?.type === "cvs" && (
                <div className="gb-card flex flex-col gap-2 p-3 text-sm" data-gb="cvs-store">
                  {props.cvsSelection?.methodId === shipMethod.id ? (
                    <>
                      <input type="hidden" name="cvsSelectionId" value={props.cvsSelection.id} />
                      <span>
                        取貨門市：<strong>{props.cvsSelection.store.name}</strong>（{props.cvsSelection.store.address}）
                      </span>
                    </>
                  ) : (
                    <span>請先選擇取貨門市。</span>
                  )}
                  <button
                    type="submit"
                    formAction={props.cvsStartAction}
                    formNoValidate
                    name="methodId"
                    value={shipMethod.id}
                    onClick={saveDraft}
                    className="gb-btn self-start"
                    data-gb="cvs-pick"
                  >
                    {props.cvsSelection?.methodId === shipMethod.id ? "重新選擇門市" : "選擇取貨門市"}
                  </button>
                  <span className="gb-muted text-xs">超商取貨的收件人姓名需為中文 2–5 字或英文 4–10 字，電話需為手機。</span>
                </div>
              )}
            </fieldset>
          )}
          {props.couponsEnabled && (
            <div className="flex flex-col gap-1 text-sm" data-gb="coupon">
              <span className="font-medium">折扣碼</span>
              <input type="hidden" name="couponCode" value={coupon} />
              <span className="flex flex-wrap gap-2">
                <input aria-label="折扣碼" value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} maxLength={32} className="gb-input" style={{ width: "12rem" }} />
                <button type="button" className="gb-btn" onClick={() => setCoupon(couponInput.trim())}>
                  套用
                </button>
                {coupon && (
                  <button type="button" className="text-sm underline" style={{ background: "none", border: 0, cursor: "pointer", color: "var(--gb-text)" }} onClick={() => { setCoupon(""); setCouponInput(""); }}>
                    移除
                  </button>
                )}
              </span>
              {quote?.couponMessage && <span className={quote.discount ? "" : "text-red-700"}>{quote.couponMessage}</span>}
            </div>
          )}
          {props.credits && (props.credits.points || props.credits.wallet) && (
            <div className="flex flex-col gap-2 text-sm" data-gb="member-credits">
              <input type="hidden" name="pointsToUse" value={points || ""} />
              <input type="hidden" name="walletToUse" value={wallet || ""} />
              {props.credits.points && (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">點數折抵</span>
                  <span className="gb-muted">可用 {quote?.pointsAvailable ?? 0} 點，這筆最多 {quote?.maxPoints ?? 0} 點（1 點＝{twd(quote?.pointValue ?? 1)}）</span>
                  <input aria-label="使用點數" inputMode="numeric" value={pointsInput} onChange={(e) => setPointsInput(e.target.value.replace(/\D/g, ""))} className="gb-input" style={{ width: "7rem" }} />
                  <button type="button" className="gb-btn" onClick={() => setPoints(Number(pointsInput) || 0)}>套用</button>
                  <button type="button" className="text-sm underline" style={{ background: "none", border: 0, cursor: "pointer", color: "var(--gb-text)" }} onClick={() => { const n = quote?.maxPoints ?? 0; setPointsInput(String(n)); setPoints(n); }}>用最多</button>
                </span>
              )}
              {props.credits.wallet && (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">儲值金</span>
                  <span className="gb-muted">餘額 {twd(quote?.walletAvailable ?? 0)}</span>
                  <input aria-label="使用儲值金" inputMode="numeric" value={walletInput} onChange={(e) => setWalletInput(e.target.value.replace(/\D/g, ""))} className="gb-input" style={{ width: "7rem" }} />
                  <button type="button" className="gb-btn" onClick={() => setWallet(Number(walletInput) || 0)}>套用</button>
                </span>
              )}
              {quote?.creditMessages?.map((m, i) => (
                <span key={i} className="text-red-700">{m}</span>
              ))}
            </div>
          )}
          {props.previewToken && <input type="hidden" name="preview" value={props.previewToken} />}
          {props.invoiceOptions && <InvoiceFields options={props.invoiceOptions} />}
          {fullyCovered && <p className="m-0 text-sm" data-gb="fully-covered">已用點數／儲值金全額折抵，不需另外付款。</p>}
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" hidden={fullyCovered}>
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
                {usedCredits ? `折抵後剩 ${twd(quote!.total)}，低於線上付款最低金額 NT$${props.minOnline}：請少用一些點數／儲值金、全額折抵，或改用其他付款方式。` : `線上付款最低金額為 NT$${props.minOnline}，請改用其他付款方式或加購商品。`}
              </p>
            )}
          </fieldset>
          <button type="submit" className="gb-btn self-start" disabled={submitting || !quote || quote.problems.length > 0 || belowMin || (!!methods && (!shipId || !cvsReady)) || (!!coupon && !quote.discount)}>
            {submitting ? "處理中…" : fullyCovered ? "送出訂單（全額折抵）" : method === "pchomepay" ? "前往付款" : "送出訂單"}
          </button>
        </form>
      )}
    </div>
  );
}
