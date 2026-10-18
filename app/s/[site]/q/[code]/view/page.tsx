import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { QR_CODE_RE } from "@/lib/services/qrcatalog";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { QrLanding } from "@/modules/qr-catalog/landing";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// QR 落地頁與商品頁內容重複：不收錄
export const metadata: Metadata = { robots: { index: false } };

type Props = { params: Promise<{ site: string; code: string }>; searchParams: Promise<{ preview?: string; ok?: string; err?: string }> };

/** 掃碼落地頁（語言由網址前綴決定：/s/<slug>/<lang>/q/<碼>/view；這裡不記錄掃描——記錄在短連結 /q/<碼>） */
export default async function QrViewPage(props: Props) {
  const [{ site: raw, code }, sp] = await Promise.all([props.params, props.searchParams]);
  if (!QR_CODE_RE.test(code)) notFound();
  const site = await loadModulePage(raw, "qr-catalog", sp.preview);
  if (!site) notFound();
  const qr = await getStore().getQrCodeByCode(site.tenant.id, code);
  if (!qr || qr.status !== "active") notFound();
  const p = await getStore().getProductById(site.tenant.id, qr.product_id);
  if (!p || (p.status !== "published" && site.mode !== "preview")) notFound();
  const ctx = makeRenderCtx(site, `/q/${code}/view`);
  return (
    <SiteShell ctx={ctx}>
      <QrLanding ctx={ctx} code={code} productId={p.id} sp={sp} />
    </SiteShell>
  );
}
