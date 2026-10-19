import { headers } from "next/headers";
import { BuildForm } from "@/components/build/BuildForm";
import { buildCatalog } from "@/lib/platform/pricing";
import { platformPayConfig } from "@/lib/platform/payment";
import { THEME_PRESETS } from "@/lib/themes";
import { sandboxAllowed } from "@/lib/platform/routes";

export const dynamic = "force-dynamic";
export const metadata = { title: "開一個網站｜Gather Builder", description: "勾選需要的功能、即時看到價格，付款後網站自動建好。" };

export default async function BuildPage({ searchParams }: { searchParams: Promise<{ err?: string; t?: string }> }) {
  const sp = await searchParams;
  const h = await headers();
  const cfg = platformPayConfig();
  const req = new Request("http://internal/", { headers: new Headers(h) });
  // sandbox 金鑰：只在本機或帶平台測試簽章時可以結帳（否則顯示尚未開放）
  const open = !!cfg && (!cfg.sandbox || sandboxAllowed(req, sp.t));
  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="mt-0 text-2xl font-bold">開一個網站</h1>
      <p className="text-neutral-600">勾選需要的功能（相依的功能會自動帶入），即時看到建置費與月費。付款完成後網站、店主後台與 AI agent 連線會自動準備好。</p>
      {sp.err && (
        <p role="alert" className="rounded bg-red-50 px-4 py-3 text-sm text-red-900" data-build="err">
          {sp.err}
        </p>
      )}
      <BuildForm catalog={buildCatalog()} themes={THEME_PRESETS.map((t) => ({ id: t.id, name: t.name }))} paymentsOpen={open} sandbox={!!cfg?.sandbox} testToken={cfg?.sandbox && sp.t ? sp.t : null} />
    </main>
  );
}
