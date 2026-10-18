"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "model"; text: string };

/** 網站右下角 AI 客服。對話識別碼存在 localStorage（每個網站各自一組）；伺服器端依「網站＋識別碼」隔離。 */
export function ChatWidget(props: { endpoint: string; slug: string; title: string; greeting: string; path: string; bottom?: number }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{ role: "model", text: props.greeting }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sid = useRef("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const k = `gb-ai-${props.slug}`;
    try {
      sid.current = localStorage.getItem(k) ?? "";
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(sid.current)) {
        const a = new Uint8Array(18);
        crypto.getRandomValues(a);
        sid.current = btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
        localStorage.setItem(k, sid.current);
      }
    } catch {
      sid.current = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    }
  }, [props.slug]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs, open]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await fetch(props.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid.current, message: text, path: props.path }) });
      const j = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
      setMsgs((m) => [...m, { role: "model", text: j.reply ?? j.error ?? "抱歉，暫時無法回應。" }]);
    } catch {
      setMsgs((m) => [...m, { role: "model", text: "連線失敗，請稍後再試。" }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", right: 16, bottom: props.bottom ?? 16, zIndex: 60 }} data-gb="ai-chat">
      {open && (
        <div className="gb-card flex flex-col" style={{ width: "min(360px, calc(100vw - 32px))", height: "min(520px, calc(100vh - 96px))", marginBottom: 12, background: "var(--gb-bg)", boxShadow: "0 10px 30px rgba(0,0,0,.18)" }} role="dialog" aria-label={props.title}>
          <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
            <strong>{props.title}</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="關閉" style={{ background: "none", border: 0, cursor: "pointer", color: "var(--gb-text)", fontSize: 18 }}>
              ×
            </button>
          </div>
          <div ref={listRef} className="flex flex-1 flex-col gap-2 overflow-y-auto p-3 text-sm">
            {msgs.map((m, i) => (
              <p key={i} className="m-0 whitespace-pre-line rounded px-3 py-2" style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", background: m.role === "user" ? "var(--gb-primary)" : "var(--gb-surface)", color: m.role === "user" ? "var(--gb-primary-contrast, #fff)" : "var(--gb-text)" }}>
                {m.text}
              </p>
            ))}
            {busy && <p className="gb-muted m-0 text-xs">輸入中…</p>}
          </div>
          <form onSubmit={send} className="flex gap-2 border-t p-3" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} maxLength={800} placeholder="輸入問題…" aria-label="輸入問題" className="gb-input min-w-0 flex-1" />
            <button type="submit" className="gb-btn" disabled={busy || !input.trim()}>
              送出
            </button>
          </form>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={() => setOpen((o) => !o)} className="gb-btn" aria-expanded={open} style={{ borderRadius: 999, padding: "12px 18px", boxShadow: "0 6px 18px rgba(0,0,0,.18)" }}>
          {open ? "收合" : "線上客服"}
        </button>
      </div>
    </div>
  );
}
