"use client";

import { useState } from "react";

export function NewsletterSignupClient(props: { endpoint: string; buttonLabel: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("sending");
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const res = await fetch(props.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(j.error ?? "訂閱失敗，請稍後再試");
      setMsg(j.message ?? "請到信箱點確認連結");
      setState("done");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "訂閱失敗");
      setState("error");
    }
  }
  if (state === "done") {
    return (
      <p role="status" className="gb-card p-4" data-gb="newsletter-done">
        {msg}
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap gap-2" data-gb="newsletter-form">
      <input name="email" type="email" required maxLength={254} placeholder="you@example.com" aria-label="Email" className="gb-input min-w-0 flex-1" autoComplete="email" />
      <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
        <input name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <button type="submit" className="gb-btn" disabled={state === "sending"}>
        {state === "sending" ? "送出中…" : props.buttonLabel}
      </button>
      {state === "error" && (
        <p role="alert" className="m-0 w-full text-sm" style={{ color: "#b91c1c" }}>
          {msg}
        </p>
      )}
    </form>
  );
}
