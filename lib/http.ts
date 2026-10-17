import { ServiceError } from "./services/context";

const STATUS: Record<ServiceError["code"], number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  confirm_required: 400,
  rate_limited: 429,
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ServiceError) return json({ error: e.message, code: e.code }, STATUS[e.code]);
  console.error(e);
  return json({ error: "伺服器錯誤" }, 500);
}
