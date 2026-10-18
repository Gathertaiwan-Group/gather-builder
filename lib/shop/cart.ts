/** 瀏覽器購物車（localStorage）。只存「哪個商品、規格、幾件」＋顯示用名稱；價格一律由 server 重算。 */
export interface CartLine {
  productId: string;
  variantId: string | null;
  qty: number;
  name: string;
  variantLabel?: string | null;
}

export const cartKey = (slug: string) => `gb_cart_${slug}`;

export function readCart(slug: string): CartLine[] {
  try {
    const v = JSON.parse(localStorage.getItem(cartKey(slug)) ?? "[]");
    return Array.isArray(v) ? v.filter((l) => l && typeof l.productId === "string" && Number.isInteger(l.qty) && l.qty > 0).slice(0, 30) : [];
  } catch {
    return [];
  }
}

export function writeCart(slug: string, lines: CartLine[]) {
  try {
    localStorage.setItem(cartKey(slug), JSON.stringify(lines.slice(0, 30)));
    window.dispatchEvent(new Event("gb-cart"));
  } catch {
    /* 私密模式等：略過 */
  }
}

export function addToCart(slug: string, line: CartLine) {
  const lines = readCart(slug);
  const hit = lines.find((l) => l.productId === line.productId && (l.variantId ?? null) === (line.variantId ?? null));
  if (hit) hit.qty = Math.min(99, hit.qty + line.qty);
  else lines.push(line);
  writeCart(slug, lines);
}
