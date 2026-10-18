import { getStore } from "@/lib/store";
import { localizeRow } from "@/lib/services/i18n";
import { renderMarkdown } from "@/lib/markdown";
import { moduleConfig } from "@/lib/site-loader";
import { DEFAULT_LANG, langLabel } from "@/lib/i18n/langs";
import { QR_LANGS } from "@/lib/services/qrcatalog";
import { siteHref, type RenderCtx } from "../render-types";
import type { QrCatalogSettings } from "./manifest";

/** 落地頁固定字串（中／英／日；其他語言用英文） */
const T: Record<string, Record<string, string>> = {
  price: { "zh-TW": "售價", en: "Price", ja: "価格" },
  fxNote: { "zh-TW": "外幣金額僅供參考，以新台幣結帳", en: "Foreign-currency amounts are for reference only; checkout is in New Taiwan Dollars (TWD).", ja: "外貨表示は参考値です。お支払いは台湾ドル（TWD）となります。" },
  inStore: { "zh-TW": "現場購買請洽店員", en: "To buy in store, please ask our staff.", ja: "店頭でのご購入はスタッフにお声がけください。" },
  buyOnline: { "zh-TW": "線上購買", en: "Buy online", ja: "オンラインで購入" },
  overseas: { "zh-TW": "寄送到海外（詢價）", en: "Ship overseas (request a quote)", ja: "海外へ配送（お見積り）" },
  overseasNote: { "zh-TW": "填寫國家與地址，店家會以 Email 回覆含國際運費的報價。", en: "Tell us your country and address — the shop will email you a quote including international shipping.", ja: "国と住所をご入力ください。国際送料を含むお見積りをメールでお送りします。" },
  name: { "zh-TW": "姓名", en: "Name", ja: "お名前" },
  email: { "zh-TW": "Email", en: "Email", ja: "メールアドレス" },
  country: { "zh-TW": "國家（兩碼，例如 JP、US）", en: "Country (2-letter code, e.g. JP, US)", ja: "国（2文字コード：JP、US など）" },
  address: { "zh-TW": "寄送地址", en: "Shipping address", ja: "配送先住所" },
  message: { "zh-TW": "留言（選填）", en: "Message (optional)", ja: "メッセージ（任意）" },
  send: { "zh-TW": "送出詢價", en: "Request a quote", ja: "見積りを依頼" },
  lang: { "zh-TW": "語言", en: "Language", ja: "言語" },
};
const t = (k: keyof typeof T, lang: string) => T[k]![lang] ?? T[k]!.en!;
const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const fx = (n: number, code: string, lang: string) => {
  try {
    return new Intl.NumberFormat(lang === DEFAULT_LANG ? "zh-TW" : lang, { style: "currency", currency: code, maximumFractionDigits: code === "JPY" || code === "KRW" ? 0 : 2 }).format(n);
  } catch {
    return `${code} ${n.toFixed(2)}`;
  }
};

export async function QrLanding({ ctx, code, productId, sp }: { ctx: RenderCtx; code: string; productId: string; sp: { ok?: string; err?: string } }) {
  const store = getStore();
  const site = ctx.site;
  const lang = site.lang;
  const p = await localizeRow(store, site, "product", await store.getProductById(site.tenant.id, productId));
  if (!p) return null;
  const settings = moduleConfig<QrCatalogSettings>(site, "qr-catalog");
  const langs = QR_LANGS.filter((l) => l === DEFAULT_LANG || site.languages.includes(l));
  const slug = site.tenant.slug;
  return (
    <section className="gb-section">
      <div className="gb-container max-w-2xl">
        {langs.length > 1 && (
          <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label={t("lang", lang)} data-gb="qr-langs">
            {langs.map((l) => (
              <a key={l} href={`/s/${slug}${l === DEFAULT_LANG ? "" : `/${l}`}/q/${code}/view`} aria-current={l === lang ? "page" : undefined} className="gb-card px-3 py-1 no-underline" style={l === lang ? { fontWeight: 700 } : undefined}>
                {langLabel(l)}
              </a>
            ))}
          </nav>
        )}
        {sp.ok && <p role="status" className="gb-card mb-4 p-3 text-sm" data-gb="ok">{sp.ok}</p>}
        {sp.err && <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">{sp.err}</p>}
        {p.images[0] && <img src={p.images[0]} alt="" className="mb-4 aspect-square w-full rounded object-cover sm:aspect-video" />}
        <h1 className="gb-h2 m-0" data-gb="qr-name">{p.name}</h1>
        <p className="m-0 mt-2 text-xl font-bold" data-gb="qr-price">
          {t("price", lang)} {twd(p.price)}
        </p>
        {!!settings.currencies?.length && (
          <div className="gb-muted mt-1 text-sm" data-gb="qr-fx">
            <p className="m-0">{settings.currencies.map((c) => `≈ ${fx(p.price * c.rate, c.code, lang)}`).join(" · ")}</p>
            <p className="m-0 text-xs">{t("fxNote", lang)}</p>
          </div>
        )}
        {p.description_md && <div className="gb-prose mt-4" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.description_md) }} />}
        <p className="gb-card mt-6 p-4 font-medium" data-gb="qr-instore">
          {settings.inStoreNote && lang === DEFAULT_LANG ? settings.inStoreNote : t("inStore", lang)}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a className="gb-btn" href={siteHref(ctx, `/shop/${p.slug}`)} data-gb="qr-buy">
            {t("buyOnline", lang)}
          </a>
          <a className="gb-btn" href="#overseas" data-gb="qr-overseas">
            {t("overseas", lang)}
          </a>
        </div>
        <form id="overseas" action={`/s/${slug}/api/qr/inquiry`} method="post" className="gb-card mt-6 flex flex-col gap-3 p-4 text-sm" data-gb="qr-inquiry">
          <p className="m-0 font-bold">{t("overseas", lang)}</p>
          <p className="gb-muted m-0">{t("overseasNote", lang)}</p>
          <input type="hidden" name="code" value={code} />
          <input type="hidden" name="lang" value={lang} />
          <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: "-9999px" }} />
          <label className="flex flex-col gap-1 font-medium">
            {t("name", lang)}
            <input className="gb-input" name="name" required maxLength={80} autoComplete="name" />
          </label>
          <label className="flex flex-col gap-1 font-medium">
            {t("email", lang)}
            <input className="gb-input" name="email" type="email" required maxLength={200} autoComplete="email" />
          </label>
          <label className="flex flex-col gap-1 font-medium">
            {t("country", lang)}
            <input className="gb-input w-28 uppercase" name="country" required pattern="[A-Za-z]{2}" maxLength={2} autoComplete="country" />
          </label>
          <label className="flex flex-col gap-1 font-medium">
            {t("address", lang)}
            <textarea className="gb-input" name="address" required minLength={5} maxLength={500} rows={3} autoComplete="street-address" />
          </label>
          <label className="flex flex-col gap-1 font-medium">
            {t("message", lang)}
            <textarea className="gb-input" name="message" maxLength={2000} rows={2} />
          </label>
          <button type="submit" className="gb-btn self-start">{t("send", lang)}</button>
        </form>
      </div>
    </section>
  );
}
