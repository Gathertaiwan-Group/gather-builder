import Script from "next/script";
import { resolveTheme, themeCssVars } from "@/lib/themes";
import { moduleActive, moduleConfig, type LoadedSite } from "@/lib/site-loader";
import { siteHref, type RenderCtx } from "@/modules/render-types";
import { LineFloating } from "@/modules/line/sections";
import { ChatWidget } from "@/modules/ai-chat/ChatWidget";
import { DEFAULT_LANG, langLabel, ui } from "@/lib/i18n/langs";
import { MustReadBanner } from "@/modules/announcements/sections";

export function makeRenderCtx(site: LoadedSite, path: string): RenderCtx {
  // 多語：非預設語言的站內連結一律帶 /<lang> 前綴
  return { site, basePath: `${site.basePath}${site.lang && site.lang !== DEFAULT_LANG ? `/${site.lang}` : ""}`, path };
}

/** 同一頁在各語言的網址（語言切換、hreflang 用）；path 為站內路徑 */
export function langHref(site: LoadedSite, lang: string, path: string): string {
  const base = `${site.basePath}${lang === DEFAULT_LANG ? "" : `/${lang}`}`;
  const q = site.mode === "preview" && site.previewToken ? `?preview=${encodeURIComponent(site.previewToken)}` : "";
  return `${base}${path === "/" ? "" : path}${q}` || "/";
}

/** 租戶網站外框：主題變數、頁首導覽、頁尾、LINE 浮動鈕、GA4、預覽橫幅 */
export function SiteShell({ ctx, children }: { ctx: RenderCtx; children: React.ReactNode }) {
  const { site } = ctx;
  const { preset } = resolveTheme(site.content.theme);
  const core = moduleConfig<{ ga4MeasurementId?: string; footerText?: string }>(site, "core");
  // 會員／結帳／訂單頁的網址可能帶一次性 token 或訂單金鑰：一律不載入 GA（GA 會把完整網址送到 Google）
  const privatePage = /^\/(account|orders|checkout|learn|book\/manage|events\/confirm)(\/|$)/.test(ctx.path) || /^\/events\/[^/]+\/offer$/.test(ctx.path);
  const ga = site.mode === "published" && !privatePage && core.ga4MeasurementId && /^G-[A-Z0-9]+$/.test(core.ga4MeasurementId) ? core.ga4MeasurementId : null;
  return (
    <div className="gb-site" style={themeCssVars(site.content.theme) as React.CSSProperties}>
      {preset.googleFonts && (
        // eslint-disable-next-line @next/next/no-page-custom-font
        <link rel="stylesheet" href={`https://fonts.googleapis.com/css2?family=${preset.googleFonts}&display=swap`} />
      )}
      {site.mode === "preview" && (
        <div className="sticky top-0 z-50 bg-amber-400 px-4 py-2 text-center text-sm font-semibold text-black" data-gb="preview-banner">
          {ui("preview", site.lang)}
        </div>
      )}
      {site.previewRejected && (
        <div className="bg-neutral-800 px-4 py-2 text-center text-sm text-white">預覽連結無效或已過期，目前顯示已發布版本。</div>
      )}
      <header className="border-b" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)", background: "var(--gb-bg)" }}>
        <div className="gb-container flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4">
          <a href={siteHref(ctx, "/")} className="text-lg font-bold no-underline" style={{ color: "var(--gb-text)", fontFamily: "var(--gb-font-heading)" }}>
            {site.tenant.name}
          </a>
          <nav aria-label="主選單" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {site.content.nav.map((n, i) => (
              <a key={i} href={siteHref(ctx, n.href)} className="no-underline" style={{ color: "var(--gb-text)" }}>
                {(site.lang !== DEFAULT_LANG && site.content.translations?.[site.lang]?.nav?.[String(i)]?.t) || n.label}
              </a>
            ))}
            {moduleActive(site, "search") && (
              <a href={siteHref(ctx, "/search")} className="no-underline" style={{ color: "var(--gb-text)" }} data-gb="search-link">
                {ui("search", site.lang)}
              </a>
            )}
            {moduleActive(site, "shop") && (
              <a href={siteHref(ctx, "/checkout")} className="no-underline" style={{ color: "var(--gb-text)" }} data-gb="cart-link">
                {ui("cart", site.lang)}
              </a>
            )}
            {moduleActive(site, "members") && (
              <a href={siteHref(ctx, "/account")} className="no-underline" style={{ color: "var(--gb-text)" }} data-gb="account-link">
                {ui("account", site.lang)}
              </a>
            )}
            {site.languages.length > 0 && (
              <span className="flex gap-2" aria-label={ui("language", site.lang)} data-gb="lang-switch">
                {[DEFAULT_LANG, ...site.languages].map((l) => (
                  <a key={l} href={langHref(site, l, ctx.path)} hrefLang={l === DEFAULT_LANG ? "zh-Hant-TW" : l} aria-current={l === site.lang ? "true" : undefined} className="no-underline" style={{ color: "var(--gb-text)", fontWeight: l === site.lang ? 700 : 400 }}>
                    {langLabel(l)}
                  </a>
                ))}
              </span>
            )}
          </nav>
        </div>
      </header>
      {moduleActive(site, "announcements") && site.mode === "published" && <MustReadBanner ctx={ctx} />}
      <main className="flex-1">{children}</main>
      <footer className="mt-8 py-8 text-sm" style={{ background: "var(--gb-surface)" }}>
        <div className="gb-container gb-muted flex flex-wrap justify-between gap-2">
          <span>{core.footerText ?? `© ${new Date().getFullYear()} ${site.tenant.name}`}</span>
          <span>Powered by Gather Builder</span>
        </div>
      </footer>
      {moduleActive(site, "line") && <LineFloating ctx={ctx} />}
      {site.modules.get("ai-chat")?.status === "enabled" && !!process.env.GEMINI_API_KEY && site.mode === "published" && !privatePage && (
        <ChatWidget
          endpoint={`/api/s/${site.tenant.slug}/ai-chat`}
          slug={site.tenant.slug}
          path={ctx.path}
          bottom={moduleActive(site, "line") ? 76 : 16}
          title={moduleConfig<{ assistantName?: string }>(site, "ai-chat").assistantName ?? `${site.tenant.name} 客服`}
          greeting={moduleConfig<{ greeting?: string }>(site, "ai-chat").greeting ?? `你好！有什麼關於 ${site.tenant.name} 的問題都可以問我。`}
        />
      )}
      {ga && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${ga}`} strategy="afterInteractive" />
          <Script id="gb-ga4" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga}');`}
          </Script>
        </>
      )}
    </div>
  );
}
