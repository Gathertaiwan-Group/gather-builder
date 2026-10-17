/** Resend 寄信；沒設 RESEND_API_KEY 回 undefined（呼叫端直接略過，不報錯） */
export function getMailer(): ((to: string, subject: string, text: string) => Promise<void>) | undefined {
  const key = process.env.RESEND_API_KEY;
  if (!key) return undefined;
  const from = process.env.RESEND_FROM ?? "Gather Builder <onboarding@resend.dev>";
  return async (to, subject, text) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
