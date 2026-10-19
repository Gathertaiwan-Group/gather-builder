import type { DnsRecord } from "../store/types-platform";

/**
 * 自有網域的「把網域加到 Vercel 專案、查驗證狀態、移除」介面。
 * 🔴 測試與驗收一律用 mock（DOMAIN_ADAPTER=mock 或注入）；正式呼叫 Vercel 的路徑只在老闆設好 env 後由後台觸發。
 *
 * Vercel REST API（https://vercel.com/docs/rest-api/reference/endpoints/projects）：
 * - 加網域  POST   /v10/projects/{projectId}/domains            body { name }
 * - 查網域  GET    /v9/projects/{projectId}/domains/{domain}     → { verified, verification[] }
 * - 觸發驗證 POST  /v9/projects/{projectId}/domains/{domain}/verify
 * - DNS 設定 GET   /v6/domains/{domain}/config                    → { misconfigured }
 * - 移除    DELETE /v9/projects/{projectId}/domains/{domain}
 * 全部帶 ?teamId=<VERCEL_TEAM_ID>（個人帳號可省略）與 Authorization: Bearer <VERCEL_API_TOKEN>。
 */
export interface DomainCheck {
  /** Vercel 已確認網域所有權（TXT 驗證，若需要） */
  verified: boolean;
  /** DNS 已正確指到 Vercel（A／CNAME） */
  configured: boolean;
  records: DnsRecord[];
  error?: string;
}

export interface DomainAdapter {
  readonly name: string;
  add(domain: string): Promise<DomainCheck>;
  check(domain: string): Promise<DomainCheck>;
  remove(domain: string): Promise<void>;
}

const TW_SLD = /\.(com|org|net|idv|gov|edu|club|ebiz|game)\.tw$/;
/** 根網域（apex）用 A 記錄，子網域用 CNAME（Vercel 官方建議值） */
export function isApex(domain: string): boolean {
  const n = domain.split(".").length;
  return TW_SLD.test(domain) ? n === 3 : n === 2;
}

export function pointingRecords(domain: string): DnsRecord[] {
  if (isApex(domain)) return [{ type: "A", name: "@", value: "76.76.21.21", reason: "把網域指到 Vercel" }];
  const sub = domain.split(".")[0]!;
  return [{ type: "CNAME", name: sub, value: "cname.vercel-dns.com", reason: "把網域指到 Vercel" }];
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createVercelDomainAdapter(cfg: { token: string; projectId: string; teamId?: string | null }, fetchImpl: FetchLike = (u, i) => fetch(u, i)): DomainAdapter {
  const q = cfg.teamId ? `?teamId=${encodeURIComponent(cfg.teamId)}` : "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`https://api.vercel.com${path}${q}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* ignore */
    }
    return { ok: res.ok, status: res.status, data };
  };
  const verificationRecords = (d: Record<string, unknown>): DnsRecord[] =>
    (Array.isArray(d.verification) ? d.verification : []).map((v: Record<string, unknown>) => ({ type: "TXT" as const, name: String(v.domain ?? ""), value: String(v.value ?? ""), reason: String(v.reason ?? "網域所有權驗證") }));
  const errMsg = (r: { status: number; data: Record<string, unknown> }) => {
    const e = r.data.error as { message?: string; code?: string } | undefined;
    return `Vercel API ${r.status}${e?.code ? ` ${e.code}` : ""}${e?.message ? `：${e.message}` : ""}`.slice(0, 300);
  };
  const id = encodeURIComponent(cfg.projectId);
  return {
    name: "vercel",
    async add(domain) {
      const r = await call("POST", `/v10/projects/${id}/domains`, { name: domain });
      // 已經在這個專案（例如重試）→ 改查狀態
      if (!r.ok && !(r.status === 409 || (r.data.error as { code?: string } | undefined)?.code === "domain_already_in_use")) {
        return { verified: false, configured: false, records: pointingRecords(domain), error: errMsg(r) };
      }
      return this.check(domain);
    },
    async check(domain) {
      const d = encodeURIComponent(domain);
      let r = await call("GET", `/v9/projects/${id}/domains/${d}`);
      if (!r.ok) return { verified: false, configured: false, records: pointingRecords(domain), error: errMsg(r) };
      if (r.data.verified !== true) {
        const v = await call("POST", `/v9/projects/${id}/domains/${d}/verify`);
        if (v.ok) r = v;
      }
      const c = await call("GET", `/v6/domains/${d}/config`);
      return {
        verified: r.data.verified === true,
        configured: c.ok && c.data.misconfigured === false,
        records: [...pointingRecords(domain), ...verificationRecords(r.data)],
        error: c.ok ? undefined : errMsg(c),
      };
    },
    async remove(domain) {
      const r = await call("DELETE", `/v9/projects/${id}/domains/${encodeURIComponent(domain)}`);
      if (!r.ok && r.status !== 404) throw new Error(errMsg(r));
    },
  };
}

/**
 * 測試／本機用：不打任何外部 API。`.test`、`.localhost`、`.example` 結尾的網域第一次檢查就算驗證完成，其他維持 pending。
 * calls 記錄每次呼叫，測試用來確認「沒有呼叫正式 API」。
 */
export function createMockDomainAdapter() {
  const calls: { op: string; domain: string }[] = [];
  const auto = (d: string) => /\.(test|localhost|example)$/.test(d);
  const adapter: DomainAdapter & { calls: typeof calls; force: Map<string, boolean> } = {
    name: "mock",
    calls,
    force: new Map(),
    async add(domain) {
      calls.push({ op: "add", domain });
      return { verified: false, configured: false, records: [...pointingRecords(domain), { type: "TXT", name: `_vercel.${domain}`, value: "vc-domain-verify=mock", reason: "網域所有權驗證（mock）" }] };
    },
    async check(domain) {
      calls.push({ op: "check", domain });
      const ok = adapter.force.get(domain) ?? auto(domain);
      return { verified: ok, configured: ok, records: pointingRecords(domain) };
    },
    async remove(domain) {
      calls.push({ op: "remove", domain });
    },
  };
  return adapter;
}

let mockSingleton: ReturnType<typeof createMockDomainAdapter> | null = null;

/** 依 env 選 adapter：DOMAIN_ADAPTER=mock → mock；有 VERCEL_DOMAINS_TOKEN＋VERCEL_DOMAINS_PROJECT_ID → Vercel；否則 null（後台顯示「平台尚未設定」） */
export function getDomainAdapter(env: Record<string, string | undefined> = process.env): DomainAdapter | null {
  if (env.DOMAIN_ADAPTER === "mock") return (mockSingleton ??= createMockDomainAdapter());
  if (env.VERCEL_DOMAINS_TOKEN && env.VERCEL_DOMAINS_PROJECT_ID) return createVercelDomainAdapter({ token: env.VERCEL_DOMAINS_TOKEN, projectId: env.VERCEL_DOMAINS_PROJECT_ID, teamId: env.VERCEL_DOMAINS_TEAM_ID });
  return null;
}

/**
 * 所有權驗證（第九批審查 M1）：除了 Vercel verified，**還要**在網域放這個租戶專屬的 TXT
 * `_gather-verify.<網域>` = `gather-verify=<token>`，證明加網域的人真的控制 DNS（避免別人先加走你的網域）。
 */
export type TxtVerifier = (name: string, expected: string) => Promise<boolean>;

export const OWNERSHIP_TXT_PREFIX = "_gather-verify";
export const ownershipTxt = (domain: string, token: string): DnsRecord => ({ type: "TXT", name: `${OWNERSHIP_TXT_PREFIX}.${domain}`, value: `gather-verify=${token}`, reason: "證明你擁有這個網域（Gather 專屬，每個網站不同）" });

export const dnsTxtVerifier: TxtVerifier = async (name, expected) => {
  const { resolveTxt } = await import("node:dns/promises");
  try {
    const rows = await resolveTxt(name);
    return rows.some((parts) => parts.join("") === `gather-verify=${expected}`);
  } catch {
    return false;
  }
};

/** mock（本機／e2e）：.test／.localhost／.example 結尾的網域一律通過，其他不通過 */
export const mockTxtVerifier: TxtVerifier = async (name) => /\.(test|localhost|example)$/.test(name);

export function getTxtVerifier(env: Record<string, string | undefined> = process.env): TxtVerifier {
  return env.DOMAIN_ADAPTER === "mock" ? mockTxtVerifier : dnsTxtVerifier;
}
