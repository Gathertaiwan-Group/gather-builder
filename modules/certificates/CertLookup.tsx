"use client";

import { useState } from "react";

type Result = { certNo: string; name: string; category: string | null; issuedOn: string | null; expiresOn: string | null; status: string; statusLabel: string };

/** 證照查詢表單：POST JSON 到 /api/s/<slug>/verify（生日不放網址） */
export function CertLookup({ endpoint, certNoOnly = false }: { endpoint: string; certNoOnly?: boolean }) {
  const [mode, setMode] = useState<"cert" | "name">("cert");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMsg(null);
    setResults(null);
    try {
      const body = mode === "cert" ? { certNo: f.get("certNo"), name: f.get("certName") || undefined } : { name: f.get("name"), birth: f.get("birth") };
      const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) setMsg(j.error ?? "查詢失敗，請稍後再試");
      else if (j.found) setResults(j.results);
      else setMsg(j.message);
    } catch {
      setMsg("查詢失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4" data-gb="cert-lookup">
      <div className="flex gap-2 text-sm" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "cert"} className="gb-btn" style={mode === "cert" ? undefined : { background: "transparent", color: "var(--gb-primary)", border: "1px solid var(--gb-primary)" }} onClick={() => setMode("cert")}>
          用證號＋姓名查詢
        </button>
        <button type="button" role="tab" aria-selected={mode === "name"} className="gb-btn" style={mode === "name" ? undefined : { background: "transparent", color: "var(--gb-primary)", border: "1px solid var(--gb-primary)" }} onClick={() => setMode("name")}>
          用姓名＋生日查詢
        </button>
      </div>
      <form onSubmit={submit} className="gb-card flex flex-col gap-3 p-4">
        {mode === "cert" ? (
          <label className="flex flex-col gap-1 text-sm font-medium">
            證號
            <input name="certNo" required maxLength={60} className="gb-input" autoComplete="off" data-gb="cert-no" />
            <span className="mt-2">姓名{certNoOnly ? "（選填）" : ""}</span>
            <input name="certName" required={!certNoOnly} maxLength={80} className="gb-input" autoComplete="name" data-gb="cert-no-name" />
          </label>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm font-medium">
              姓名
              <input name="name" required maxLength={80} className="gb-input" autoComplete="name" data-gb="cert-name" />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              生日
              <input name="birth" type="date" required className="gb-input" data-gb="cert-birth" />
            </label>
          </>
        )}
        <button className="gb-btn self-start" type="submit" disabled={busy}>
          {busy ? "查詢中…" : "查詢"}
        </button>
      </form>
      {msg && (
        <p role="status" className="gb-card m-0 p-4" data-gb="cert-message">
          {msg}
        </p>
      )}
      {results && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-gb="cert-results">
          {results.map((r, i) => (
            <li key={i} className="gb-card p-4 text-sm">
              <strong className="text-base">{r.name}</strong>　{r.category ?? ""}
              <br />
              證號：{r.certNo}
              <br />
              發證日：{r.issuedOn ?? "—"}　到期日：{r.expiresOn ?? "無"}
              <br />
              狀態：<strong data-gb="cert-status">{r.statusLabel}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
