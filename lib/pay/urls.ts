import { randomBytes } from "node:crypto";
import { ServiceError } from "../errors";
import type { ProviderId } from "./types";

/**
 * 第七批審查 H1／H2：各家 callback／導回網址的長度上限（超過會讓金流直接拒絕建單）。
 * - 藍新 MPG：ReturnURL／NotifyURL／ClientBackURL 皆 String(200)（NDNF-1.2.6 §4.2.1）。
 * - 藍新信用卡定期定額：ReturnURL／NotifyURL／BackURL 皆 String(100)（NDNP-1.0.8 §4.1）。
 * - 綠界 AioCheckOut：ReturnURL／OrderResultURL／ClientBackURL String(200)。
 * - PAYUNi UPP、黑貓 PAY：文件未明列（PAYUNi ReturnURL／NotifyURL 範例欄位為 String(200)），保守取 200。
 * - LINE Pay v3：confirmUrl／cancelUrl 500。PChomePay：未公開，保守取 200。
 * 所以所有 provider 一律用短網址：/p/n/<碼>（server 通知）、/p/r/<碼>（導回）、/p/c/<碼>（LINE Pay confirm）、
 * /p/sn|sr|sb/<碼>（定期定額通知／導回／返回）。<碼> 是付款／訂閱列上的 18 字隨機英數（約 107 bits），
 * tenant／付款由碼在 server 端查回；判定照舊一律是 provider 簽章驗證＋權威回查。
 */
export const CALLBACK_URL_LIMITS: Record<ProviderId, number> = {
  newebpay: 200,
  ecpay: 200,
  payuni: 200,
  blackcat: 200,
  pchomepay: 200,
  linepay: 500,
};
export const NEWEBPAY_PERIOD_URL_LIMIT = 100;

export const SHORT_CODE_LEN = 18;
export const SHORT_CODE_RE = /^[A-Za-z0-9]{18}$/;
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 18 字隨機英數（拒絕取樣，沒有模數偏差） */
export function genShortCode(): string {
  let s = "";
  while (s.length < SHORT_CODE_LEN) {
    for (const b of randomBytes(32)) {
      if (b < 248) s += B62[b % 62];
      if (s.length === SHORT_CODE_LEN) break;
    }
  }
  return s;
}

const trim = (b: string) => b.replace(/\/$/, "");

/** 一般線上付款的短網址 */
export function shortPayUrls(baseUrl: string, code: string, provider: ProviderId) {
  const b = trim(baseUrl);
  return {
    notifyUrl: `${b}/p/n/${code}`,
    returnUrl: provider === "linepay" ? `${b}/p/c/${code}` : `${b}/p/r/${code}`,
    cancelUrl: `${b}/p/r/${code}`,
  };
}

/** 定期定額的短網址 */
export function shortSubscriptionUrls(baseUrl: string, code: string) {
  const b = trim(baseUrl);
  return { notifyUrl: `${b}/p/sn/${code}`, returnUrl: `${b}/p/sr/${code}`, backUrl: `${b}/p/sb/${code}` };
}

/** 任何一個網址超過上限 → 拒絕（不要送出一定會被金流擋下的建單） */
export function assertUrlLengths(urls: Record<string, string>, limit: number, label: string) {
  for (const [k, v] of Object.entries(urls)) {
    if (v.length > limit) {
      throw new ServiceError("invalid", `${label} 的 ${k} 長度 ${v.length} 超過上限 ${limit} 字（平台網址 APP_URL 太長），請改用較短的網域`);
    }
  }
}

/** 平台網址最長可以多長（給設定檢查與文件用）：定期定額最緊（100 − "/p/sn/" − 18） */
export const MAX_BASE_URL_FOR_PERIOD = NEWEBPAY_PERIOD_URL_LIMIT - "/p/sn/".length - SHORT_CODE_LEN;
