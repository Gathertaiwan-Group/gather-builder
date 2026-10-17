import { fmt } from "./AdminShell";

export function TokenTable({ tokens }: { tokens: { id: string; name: string; token_prefix: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null; tenant_id: string | null }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th className="py-1 pr-3">名稱</th>
            <th className="py-1 pr-3">前綴</th>
            <th className="py-1 pr-3">scopes</th>
            <th className="py-1 pr-3">最後使用</th>
            <th className="py-1 pr-3">狀態</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id} className="border-t" data-admin="token-row">
              <td className="py-1 pr-3">{t.name}</td>
              <td className="py-1 pr-3">
                <code>{t.token_prefix}…</code>
              </td>
              <td className="py-1 pr-3 text-xs">{t.scopes.join(", ")}</td>
              <td className="py-1 pr-3">{fmt(t.last_used_at)}</td>
              <td className="py-1 pr-3">
                {t.revoked_at ? (
                  <span className="text-neutral-500">已撤銷</span>
                ) : (
                  <form action={`/api/admin/tokens/${t.id}/revoke`} method="post">
                    <button type="submit" className="text-red-700 underline">
                      撤銷
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
