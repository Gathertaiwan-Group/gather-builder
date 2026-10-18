import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { listAiChats } from "@/lib/services/ai-chat";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function AiChatAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const r = await listAiChats(ctx, { site: slug, limit: 50 }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/ai-chat" name={tenant.name} />
      {"error" in r ? (
        <Card title="AI 客服">
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        </Card>
      ) : (
        <>
          {!r.geminiConfigured && (
            <p className="rounded bg-amber-50 p-2 text-sm text-amber-800" data-admin="gemini-warning">
              ⚠️ 平台尚未設定 GEMINI_API_KEY：AI 客服模組為 pending_setup，前台不會顯示客服視窗。
            </p>
          )}
          <Card title="最近的對話（訪客留下聯絡方式會自動寫進「詢問」）">
            <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm" data-admin="ai-chats">
              {r.chats.map((c) => (
                <li key={c.sessionId} className="border-t pt-2">
                  <div className="text-xs text-neutral-500">
                    {fmt(c.lastAt)} · {c.messages} 則 {c.leadCaptured && <strong className="text-emerald-700">· 已留聯絡方式</strong>}
                  </div>
                  {c.preview.map((p, i) => (
                    <div key={i}>{p}</div>
                  ))}
                </li>
              ))}
              {r.chats.length === 0 && <li className="text-neutral-600">還沒有對話。</li>}
            </ul>
          </Card>
        </>
      )}
    </AdminShell>
  );
}
