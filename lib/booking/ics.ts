/**
 * iCalendar（RFC 5545）單一事件：CRLF 換行、TEXT 跳脫（\ ; , 換行）、超過 75 octets 折行、時間用 UTC（…Z），
 * 所以不需要 VTIMEZONE；行事曆 App 會依使用者時區顯示（台北＝UTC+8）。
 */
export interface IcsEvent {
  uid: string;
  start: Date | string;
  end: Date | string;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  /** 取消時用 CANCEL＋STATUS:CANCELLED，同一 UID 讓行事曆移除 */
  cancelled?: boolean;
  sequence?: number;
}

export const icsDate = (d: Date | string) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** 依 UTF-8 octets 折行（續行以一個空白開頭），不切斷多位元組字元 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (curLen + n > limit) {
      parts.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

export function buildIcs(ev: IcsEvent, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Gather Builder//Booking//ZH-TW",
    "CALSCALE:GREGORIAN",
    `METHOD:${ev.cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(ev.start)}`,
    `DTEND:${icsDate(ev.end)}`,
    `SEQUENCE:${ev.sequence ?? 0}`,
    `SUMMARY:${icsEscape(ev.summary)}`,
    ...(ev.description ? [`DESCRIPTION:${icsEscape(ev.description)}`] : []),
    ...(ev.location ? [`LOCATION:${icsEscape(ev.location)}`] : []),
    ...(ev.url ? [`URL:${ev.url}`] : []),
    `STATUS:${ev.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
