import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { leaderForGroupBuy } from "@/lib/services/groupbuy";
import { cvsCookieName, selectionForBrowser } from "@/lib/services/shipping";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { GroupBuyPageBody } from "@/modules/group-buy/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string; slug: string }>; searchParams: Promise<{ preview?: string; leader?: string; err?: string; ok?: string; cvs?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw, slug }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "group-buy", sp.preview);
  const g = site ? await getStore().getGroupBuyBySlug(site.tenant.id, slug) : null;
  if (!site || !g || (g.status === "draft" && site.mode !== "preview")) return { title: "找不到團購" };
  // 團主連結帶 ?leader=…：不收錄（避免分潤連結被搜尋引擎散播）
  return { title: `${g.title}｜${site.tenant.name}`, openGraph: { title: g.title, images: g.cover_url ? [g.cover_url] : undefined }, robots: sp.leader || site.tenant.is_test ? { index: false } : undefined };
}

export default async function GroupBuyPage(props: Props) {
  const [{ site: raw, slug }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "group-buy", sp.preview);
  if (!site) notFound();
  const store = getStore();
  const g = await store.getGroupBuyBySlug(site.tenant.id, slug);
  if (!g || (g.status === "draft" && site.mode !== "preview")) notFound();
  const code = sp.leader?.trim().toUpperCase() ?? null;
  const lead = code ? await leaderForGroupBuy(store, site.tenant, g, code) : null;
  const member = await currentMember(site.tenant);
  const binding = (await cookies()).get(cvsCookieName(site.tenant.id))?.value;
  const sel = await selectionForBrowser(store, site.tenant, sp.cvs, binding);
  const ctx = makeRenderCtx(site, `/groupbuy/${g.slug}`);
  return (
    <SiteShell ctx={ctx}>
      <GroupBuyPageBody ctx={ctx} slug={g.slug} leaderCode={lead ? lead.leader.code : null} leaderName={lead?.leader.name ?? null} member={member} cvs={sel ? { id: sel.id, methodId: sel.methodId, store: sel.store! } : null} sp={sp} />
    </SiteShell>
  );
}
