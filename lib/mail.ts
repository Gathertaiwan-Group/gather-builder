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

/** 附件（例如預約的 .ics）：content 為原文字串，寄出時轉 base64 */
export interface MailAttachment {
  filename: string;
  content: string;
  contentType?: string;
}
/** 第 4 個參數（附件）可省略；舊的 3 參數呼叫照常 */
export type Mailer = (to: string, subject: string, text: string, attachments?: MailAttachment[]) => Promise<void>;

/** Resend 寄信；沒設 RESEND_API_KEY 回 undefined（呼叫端直接略過，不報錯） */
export function getMailer(): Mailer | undefined {
  const key = process.env.RESEND_API_KEY;
  if (!key) return undefined;
  const from = process.env.RESEND_FROM ?? "Gather Builder <onboarding@resend.dev>";
  return async (to, subject, text, attachments) => {
    if (isReservedTestAddress(to)) {
      console.log(`[mail] 測試保留網域，不寄出「${subject.slice(0, 60)}」`);
      return;
    }
    const files = attachments?.length ? attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, "utf8").toString("base64"), ...(a.contentType ? { content_type: a.contentType } : {}) })) : undefined;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, ...(files ? { attachments: files } : {}) }),
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

/**
 * 沒設 RESEND_API_KEY 時的替代：記一筆「未寄出」。第九批審查 L12：🔴 正式環境（NODE_ENV=production）不把信件內容
 * （可能含登入／重設密碼／邀請連結）寫進 log；本機開發（或明確設 MAIL_LOG_BODIES=1，只限本機）才印出內容。
 */
export function logUnsentMail(tag: string, to: string, subject: string, text: string) {
  const masked = to.replace(/(.{2}).*@/, "$1***@");
  const showBody = process.env.NODE_ENV !== "production" || process.env.MAIL_LOG_BODIES === "1";
  console.log(`[${tag}] RESEND_API_KEY 未設定，未寄出「${subject}」給 ${masked}${showBody ? `：\n${text}` : "（正式環境不記錄內容）"}`);
}
