"use client";

import { useState } from "react";
import { addToCart } from "@/lib/shop/cart";

export function AddToCart(props: {
  slug: string;
  checkoutHref: string;
  product: { id: string; name: string; price: number; soldOut: boolean };
  variants: { id: string; label: string; price: number; soldOut: boolean }[];
}) {
  const [variantId, setVariantId] = useState<string>(props.variants.find((v) => !v.soldOut)?.id ?? props.variants[0]?.id ?? "");
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const v = props.variants.find((x) => x.id === variantId);
  const soldOut = props.variants.length ? !!v?.soldOut : props.product.soldOut;
  const price = v?.price ?? props.product.price;

  return (
    <div className="flex flex-col gap-3" data-gb="add-to-cart">
      <p className="m-0 text-2xl font-bold">NT${price.toLocaleString("en-US")}</p>
      {props.variants.length > 0 && (
        <label className="flex flex-col gap-1 text-sm font-medium">
          規格
          <select className="gb-input" value={variantId} onChange={(e) => setVariantId(e.target.value)}>
            {props.variants.map((x) => (
              <option key={x.id} value={x.id} disabled={x.soldOut}>
                {x.label}
                {x.soldOut ? "（售完）" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex max-w-[8rem] flex-col gap-1 text-sm font-medium">
        數量
        <input className="gb-input" type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="gb-btn"
          disabled={soldOut}
          onClick={() => {
            addToCart(props.slug, { productId: props.product.id, variantId: v?.id ?? null, qty, name: props.product.name, variantLabel: v?.label ?? null });
            setAdded(true);
          }}
        >
          {soldOut ? "已售完" : "加入購物車"}
        </button>
        {added && (
          <a href={props.checkoutHref} className="text-sm" style={{ color: "var(--gb-primary)" }} role="status">
            已加入，前往結帳 →
          </a>
        )}
      </div>
    </div>
  );
}
