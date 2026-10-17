"use client";

import { useState } from "react";

export function ContactFormClient(props: { endpoint: string; path: string; submitLabel: string; successMessage: string; showPhone: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("sending");
    setError("");
    const fd = new FormData(e.currentTarget);
    const body = Object.fromEntries(fd.entries());
    try {
      const res = await fetch(props.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, path: props.path }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "送出失敗，請稍後再試");
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "送出失敗");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p role="status" className="gb-card p-6 text-center text-lg" data-gb="contact-success">
        {props.successMessage}
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="gb-card flex flex-col gap-4 p-5 md:p-8" noValidate={false}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          姓名
          <input name="name" required maxLength={80} className="gb-input" autoComplete="name" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Email
          <input name="email" type="email" required maxLength={200} className="gb-input" autoComplete="email" />
        </label>
      </div>
      {props.showPhone && (
        <label className="flex flex-col gap-1 text-sm font-medium">
          電話（選填）
          <input name="phone" type="tel" maxLength={40} className="gb-input" autoComplete="tel" />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm font-medium">
        留言
        <textarea name="message" required maxLength={4000} rows={5} className="gb-input" />
      </label>
      {/* honeypot：真人看不到；機器人會填 */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {error && (
        <p role="alert" className="m-0 text-sm" style={{ color: "#b91c1c" }}>
          {error}
        </p>
      )}
      <button type="submit" className="gb-btn self-start" disabled={state === "sending"}>
        {state === "sending" ? "送出中…" : props.submitLabel}
      </button>
    </form>
  );
}
