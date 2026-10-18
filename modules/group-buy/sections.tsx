import type { z } from "zod";
import { getStore } from "@/lib/store";
import { localizeRows } from "@/lib/services/i18n";
import { publicGroupBuy, publicGroupBuys, type PublicGroupBuyItem } from "@/lib/services/groupbuy";
import { fmtTaipei } from "@/lib/services/class-orders";
import { renderMarkdown } from "@/lib/markdown";
import { moduleActive, moduleConfig } from "@/lib/site-loader";
import { shippingSettings } from "@/modules/shipping/manifest";
import { availableShippingMethods } from "@/lib/services/shipping";
import type { GroupBuyRow, MemberRow } from "@/lib/store/types";
import { ContactFields, PaymentFields, canPay, payOptionsFor } from "@/components/site/ClassForms";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { groupBuyDetailProps, groupBuyListProps, GroupBuySettings } from "./manifest";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

function Badge({ g, open }: { g: GroupBuyRow; open: boolean }) {
  const label = open ? `截止 ${fmtTaipei(g.ends_at)}` : g.status === "closed" ? "已結團" : g.status === "failed" ? "未成團" : g.starts_at && Date.parse(g.starts_at) > Date.now() ? `${fmtTaipei(g.starts_at)} 開團` : "已截止";
  return <span className="gb-muted text-sm">{label}</span>;
}

export const GroupBuyList: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof groupBuyListProps>;
  const items = await publicGroupBuys(getStore(), ctx.site.tenant, { limit: p.limit, showClosed: p.showClosed });
  return (
    <section className="gb-section">
      <div className="gb-container">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {items.length === 0 ? (
          <p className="gb-muted">目前沒有開團中的團購。</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            {items.map(({ groupBuy: g, minPrice, open }) => (
              <a key={g.id} href={siteHref(ctx, `/groupbuy/${g.slug}`)} className="gb-card block overflow-hidden text-inherit no-underline" data-gb="groupbuy-card">
                {g.cover_url ? <img src={g.cover_url} alt="" loading="lazy" className="aspect-video w-full object-cover" /> : <div className="aspect-video w-full" style={{ background: "color-mix(in srgb, var(--gb-primary) 12%, transparent)" }} />}
                <div className="p-4">
                  <h3 className="m-0 text-base font-bold">{g.title}</h3>
                  <p className="m-0 mt-1">
                    <Badge g={g} open={open} />
                  </p>
                  {minPrice !== null && <p className="m-0 mt-1 text-sm">團購價 {twd(minPrice)} 起</p>}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

export const GroupBuyDetail: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof groupBuyDetailProps>;
  const store = getStore();
  const v = await publicGroupBuy({ store, baseUrl: "" }, ctx.site.tenant, p.groupBuySlug, { preview: ctx.site.mode === "preview" });
  if (!v) return null;
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        <div className="gb-card p-5" data-gb="groupbuy-summary">
          <h2 className="gb-h2 m-0">{p.heading ?? v.groupBuy.title}</h2>
          <p className="m-0 mt-1">
            <Badge g={v.groupBuy} open={v.open} />
          </p>
          <ul className="m-0 mt-3 list-none p-0 text-sm">
            {v.items.slice(0, 6).map((i) => (
              <li key={i.id}>
                {i.name}
                {i.variantLabel ? `（${i.variantLabel}）` : ""} · 團購價 {twd(i.price)}
              </li>
            ))}
          </ul>
          <a className="gb-btn mt-4 inline-block" href={siteHref(ctx, `/groupbuy/${v.groupBuy.slug}`)}>
            {v.open ? "前往下單" : "查看團購"}
          </a>
        </div>
      </div>
    </section>
  );
};

/** 團購頁本體（/groupbuy/<slug>）：品項、數量、聯絡、運送（自取點／運送方式／超商選店）、付款（匯款可填帳號末五碼） */
export async function GroupBuyPageBody({ ctx, slug, leaderCode, leaderName, member, cvs, sp }: { ctx: RenderCtx; slug: string; leaderCode: string | null; leaderName: string | null; member: MemberRow | null; cvs: { id: string; methodId: string; store: { name: string; address: string } } | null; sp: { err?: string; ok?: string } }) {
  const store = getStore();
  const site = ctx.site;
  const v = await publicGroupBuy({ store, baseUrl: "" }, site.tenant, slug, { preview: site.mode === "preview" });
  if (!v) return null;
  const g = v.groupBuy;
  const loc = await localizeRows(store, site, "product", v.items.map((i) => ({ id: i.productId, name: i.name })));
  const items: (PublicGroupBuyItem & { displayName: string })[] = v.items.map((i, k) => ({ ...i, displayName: loc[k]?.name ?? i.name }));
  const pay = await payOptionsFor(site);
  const gbs = moduleConfig<GroupBuySettings>(site, "group-buy");
  const shipParsed = moduleActive(site, "shipping") ? shippingSettings.safeParse(moduleConfig(site, "shipping")) : null;
  const methods = shipParsed?.success ? (await availableShippingMethods(store, site.tenant, shipParsed.data, { allowStage: site.mode === "preview" })).filter((m) => !g.shipping_method_ids || g.shipping_method_ids.includes(m.id)) : [];
  const slugBase = `/s/${site.tenant.slug}`;
  const returnPath = `/groupbuy/${g.slug}`;
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        {sp.err && (
          <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">
            {sp.err}
          </p>
        )}
        {g.cover_url && <img src={g.cover_url} alt="" className="mb-4 aspect-video w-full rounded object-cover" />}
        <h1 className="gb-h2 m-0" data-gb="groupbuy-title">{g.title}</h1>
        <p className="m-0 mt-1">
          <Badge g={g} open={v.open} />
          {g.min_qty !== null && <span className="gb-muted ml-2 text-sm">成團門檻 {g.min_qty} 件（目前 {v.soldQty} 件{v.formed ? "，已成團" : ""}）</span>}
        </p>
        {leaderName && <p className="gb-card mt-3 p-3 text-sm" data-gb="groupbuy-leader">團主：{leaderName}</p>}
        {g.description_md && <div className="gb-prose mt-4" dangerouslySetInnerHTML={{ __html: renderMarkdown(g.description_md) }} />}
        {!v.open ? (
          <p className="gb-card mt-6 p-4" data-gb="groupbuy-closed">
            {g.status === "closed" ? "這個團購已結團，感謝參與！" : g.status === "failed" ? "這個團購未達成團門檻，已取消。" : "這個團購目前不開放下單。"}
          </p>
        ) : !canPay(pay) ? (
          <p className="gb-card mt-6 p-4">此商店尚未開放結帳。</p>
        ) : (
          <>
            {methods.some((m) => m.type === "cvs") && (
              <form action={`${slugBase}/api/shipping/cvs-start`} method="post" className="gb-card mt-6 flex flex-wrap items-center gap-2 p-4 text-sm" data-gb="groupbuy-cvs">
                <span className="font-medium">超商取貨：請先選門市</span>
                <select name="methodId" className="gb-input w-auto">
                  {methods.filter((m) => m.type === "cvs").map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}（{twd(m.fee)}）
                    </option>
                  ))}
                </select>
                <input type="hidden" name="returnPath" value={returnPath} />
                {site.mode === "preview" && site.previewToken && <input type="hidden" name="preview" value={site.previewToken} />}
                <button type="submit" className="gb-btn">選擇門市</button>
                {cvs && <span data-gb="groupbuy-cvs-store">已選：{cvs.store.name}（{cvs.store.address}）</span>}
              </form>
            )}
            <form action={`${slugBase}/api/groupbuy/order`} method="post" className="mt-6 flex flex-col gap-5" data-gb="groupbuy-form">
              <input type="hidden" name="groupBuy" value={g.slug} />
              {leaderCode && <input type="hidden" name="leader" value={leaderCode} />}
              {site.mode === "preview" && site.previewToken && <input type="hidden" name="preview" value={site.previewToken} />}
              {cvs && <input type="hidden" name="cvsSelectionId" value={cvs.id} />}
              <fieldset className="gb-card m-0 flex flex-col gap-3 p-4">
                <legend className="font-medium">選購品項</legend>
                {items.map((i) => (
                  <label key={i.id} className="flex flex-wrap items-center justify-between gap-3 text-sm" data-gb="groupbuy-item">
                    <span className="flex items-center gap-3">
                      {i.image && <img src={i.image} alt="" className="h-12 w-12 rounded object-cover" />}
                      <span>
                        <span className="font-medium">{i.displayName}</span>
                        {i.variantLabel && <span className="gb-muted">（{i.variantLabel}）</span>}
                        <span className="block">
                          團購價 <strong>{twd(i.price)}</strong>
                          {i.regularPrice > i.price && <s className="gb-muted ml-2">{twd(i.regularPrice)}</s>}
                          {i.remaining !== null && <span className="gb-muted ml-2">{i.remaining > 0 ? `剩 ${i.remaining}` : "已售完"}</span>}
                        </span>
                      </span>
                    </span>
                    <input className="gb-input w-20" type="number" name={`qty_${i.id}`} min={0} max={Math.min(99, i.remaining ?? 99)} defaultValue={0} disabled={i.remaining === 0} aria-label={`${i.displayName} 數量`} />
                  </label>
                ))}
              </fieldset>
              <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
                <legend className="mb-1 font-medium">訂購人</legend>
                <ContactFields member={member} />
              </fieldset>
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 text-sm">
                <legend className="mb-1 font-medium">取貨方式</legend>
                {g.pickup_points.map((pt, k) => (
                  <label key={pt.id} className="flex items-start gap-2">
                    <input type="radio" name="ship" value={`pickup:${pt.id}`} defaultChecked={k === 0 && !cvs} required />
                    <span>
                      到店自取：{pt.name}（免運）<span className="gb-muted block text-xs">{pt.address}{pt.hours ? ` · ${pt.hours}` : ""}</span>
                    </span>
                  </label>
                ))}
                {methods.map((m) => (
                  <label key={m.id} className="flex items-start gap-2">
                    <input type="radio" name="ship" value={`method:${m.id}`} defaultChecked={cvs ? cvs.methodId === m.id : !g.pickup_points.length && m === methods[0]} disabled={m.type === "cvs" && cvs?.methodId !== m.id} required />
                    <span>
                      {m.label}（{twd(m.fee)}
                      {m.freeThreshold !== undefined ? `，滿 ${twd(m.freeThreshold)} 免運` : ""}）{m.type === "cvs" && cvs?.methodId !== m.id && <span className="gb-muted">（請先在上方選門市）</span>}
                      {m.instructions && <span className="gb-muted block text-xs">{m.instructions}</span>}
                    </span>
                  </label>
                ))}
                {!g.pickup_points.length && !methods.length && <p className="gb-muted m-0">宅配（運費依商店設定）</p>}
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 font-medium">
                    收件人（同訂購人可空白）
                    <input className="gb-input" name="shipName" maxLength={80} autoComplete="shipping name" />
                  </label>
                  <label className="flex flex-col gap-1 font-medium">
                    收件電話（同訂購人可空白）
                    <input className="gb-input" name="shipPhone" type="tel" maxLength={40} />
                  </label>
                  <label className="flex flex-col gap-1 font-medium">
                    宅配地址（自取／超商免填）
                    <input className="gb-input" name="shipAddress" maxLength={300} autoComplete="shipping street-address" />
                  </label>
                </div>
              </fieldset>
              {pay && <PaymentFields pay={pay} />}
              {pay?.offline && (
                <label className="flex flex-col gap-1 text-sm font-medium">
                  匯款帳號末五碼（選填，匯款後也可以在訂單頁補填；店家用來核對入帳）
                  <input className="gb-input w-40" name="payerLast5" inputMode="numeric" pattern="\d{5}" maxLength={5} />
                </label>
              )}
              {gbs.paymentNote && <p className="gb-muted m-0 text-sm">{gbs.paymentNote}</p>}
              <label className="flex flex-col gap-1 text-sm font-medium">
                備註（選填）
                <textarea className="gb-input" name="note" maxLength={500} rows={2} />
              </label>
              <button type="submit" className="gb-btn self-start" data-gb="groupbuy-submit">
                送出團購訂單
              </button>
              <p className="gb-muted m-0 text-xs">金額以團購價計算，運費與折扣在送出時由系統計算並顯示於訂單頁。</p>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
