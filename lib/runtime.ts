import { getStore } from "./store";
import { requireSecret } from "./secrets";
import type { Actor } from "./tokens";
import type { ServiceContext } from "./services/context";

/** 從 request 推出對外網址（APP_URL 優先） */
export function baseUrlFrom(req?: { headers: Headers } | null): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = req?.headers;
  const host = h?.get("x-forwarded-host") ?? h?.get("host");
  if (host) return `${h?.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
  return "http://localhost:3000";
}

export function makeContext(actor: Actor, req?: { headers: Headers } | null): ServiceContext {
  return { actor, store: getStore(), baseUrl: baseUrlFrom(req), previewSecret: requireSecret("PREVIEW_SECRET") };
}
