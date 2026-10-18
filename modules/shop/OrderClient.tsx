"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { writeCart } from "@/lib/shop/cart";

/** 下單成功清空購物車；待付款（線上）時每 5 秒重新整理狀態（狀態只由 server 端 notify 回查更新） */
export function OrderClient({ slug, clearCart, poll }: { slug: string; clearCart: boolean; poll: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (clearCart) writeCart(slug, []);
  }, [clearCart, slug]);
  useEffect(() => {
    if (!poll) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 60) return clearInterval(t);
      router.refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [poll, router]);
  return null;
}
