/**
 * 保留給測試的網域（RFC 2606／6761）：e2e 與測試租戶都用這些假信箱，絕不實際寄出（避免退信傷寄件信譽）。
 * 只略過、不報錯。
 */
export function isReservedTestAddress(to: string): boolean {
  const domain = to.trim().toLowerCase().split("@").pop() ?? "";
  return (
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain === "localhost" ||
    /\.(test|invalid|example|localhost)$/.test(domain) ||
    /(^|\.)example\.(com|net|org)$/.test(domain)
  );
}

/** Resend 寄信；沒設 RESEND_API_KEY 回 undefined（呼叫端直接略過，不報錯） */
export function getMailer(): ((to: string, subject: string, text: string) => Promise<void>) | undefined {
  const key = process.env.RESEND_API_KEY;
  if (!key) return undefined;
  const from = process.env.RESEND_FROM ?? "Gather Builder <onboarding@resend.dev>";
  return async (to, subject, text) => {
    if (isReservedTestAddress(to)) {
      console.log(`[mail] 測試保留網域，不寄出「${subject.slice(0, 60)}」`);
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/** 寄信並回傳 Resend 的訊息 id（電子報記錄寄送結果用）；保留網域回 { skipped: true } */
export async function sendMailWithId(to: string, subject: string, text: string, headers?: Record<string, string>): Promise<{ id: string | null; skipped: boolean }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY 未設定");
  if (isReservedTestAddress(to)) return { id: null, skipped: true };
  const from = process.env.RESEND_FROM ?? "Gather Builder <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text, headers }),
    cache: "no-store",
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  try {
    return { id: (JSON.parse(body) as { id?: string }).id ?? null, skipped: false };
  } catch {
    return { id: null, skipped: false };
  }
}
