/**
 * 可預約時段純函式：跨日、緩衝、例外日（休假／加開）、已預約衝突、時區（台北，與執行環境時區無關）、最早／最遠、.ics。
 */
import { describe, expect, it } from "vitest";
import { addDays, canSelfCancel, computeAvailability, dayWindows, isBookable, parseHm, taipeiDateOf, weekdayOf, type AvailabilityInput } from "@/lib/booking/availability";
import { buildIcs, foldLine, icsEscape } from "@/lib/booking/ics";

const tpe = (date: string, hm: string) => new Date(`${date}T${hm}:00+08:00`);
// 2026-10-19 是週一
const MON = "2026-10-19";

function base(over: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    now: tpe("2026-10-18", "12:00"),
    fromDate: MON,
    days: 1,
    weekly: [{ weekday: 1, startMin: 9 * 60, endMin: 12 * 60 }],
    overrides: [],
    busy: [],
    durationMin: 60,
    bufferMin: 0,
    stepMin: 60,
    minLeadMin: 120,
    maxAdvanceDays: 60,
    ...over,
  };
}
const starts = (r: ReturnType<typeof computeAvailability>, i = 0) => r[i]!.slots.map((s) => new Date(new Date(s.start).getTime() + 8 * 3600_000).toISOString().slice(11, 16));

describe("台北時區換算", () => {
  it("日期與星期：UTC 前一天 16:00 以後就是台北的隔天", () => {
    expect(taipeiDateOf(new Date("2026-10-18T16:00:00Z"))).toBe("2026-10-19");
    expect(taipeiDateOf(new Date("2026-10-18T15:59:59Z"))).toBe("2026-10-18");
    expect(weekdayOf(MON)).toBe(1);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("時段以台北 09:00 = UTC 01:00 輸出（與 process TZ 無關）", () => {
    const r = computeAvailability(base());
    expect(r[0]!.slots[0]!.start).toBe("2026-10-19T01:00:00.000Z");
    expect(starts(r)).toEqual(["09:00", "10:00", "11:00"]);
  });
});

describe("每週時段、間隔、時長", () => {
  it("結束時間不能超出營業時間；間隔 30 分", () => {
    expect(starts(computeAvailability(base({ stepMin: 30, durationMin: 90 })))).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });
  it("一天多段、重疊的段會合併", () => {
    expect(dayWindows(MON, [{ weekday: 1, startMin: 540, endMin: 720 }, { weekday: 1, startMin: 700, endMin: 780 }, { weekday: 1, startMin: 840, endMin: 900 }], [])).toEqual([
      [540, 780],
      [840, 900],
    ]);
  });
  it("沒排班的星期沒有時段", () => {
    expect(computeAvailability(base({ fromDate: "2026-10-20" }))[0]!.slots).toEqual([]);
  });
});

describe("緩衝", () => {
  it("既有預約 09:00–10:00＋緩衝 30 分 → 10:00 不可約，10:30 起可約", () => {
    const r = computeAvailability(base({ stepMin: 30, busy: [{ start: tpe(MON, "09:00"), end: tpe(MON, "10:30") }] }));
    expect(starts(r)).toEqual(["10:30", "11:00"]);
  });
  it("新預約自己的緩衝不能壓到下一筆：11:00 有預約、服務緩衝 30 分 → 10:00（10:00–11:00＋30）不可約", () => {
    const r = computeAvailability(base({ bufferMin: 30, busy: [{ start: tpe(MON, "11:00"), end: tpe(MON, "12:00") }] }));
    expect(starts(r)).toEqual(["09:00"]);
  });
  it("最後一格的緩衝可以超過打烊時間（只要求服務本身在營業時間內）", () => {
    expect(starts(computeAvailability(base({ bufferMin: 45 })))).toContain("11:00");
  });
});

describe("跨日", () => {
  it("營業到 24:00：23:00 那格存在；前一晚 23:00–24:00＋緩衝 60 分 → 隔天 00:00 那格被擋", () => {
    const weekly = [
      { weekday: 1, startMin: 22 * 60, endMin: 24 * 60 },
      { weekday: 2, startMin: 0, endMin: 2 * 60 },
    ];
    const r1 = computeAvailability(base({ weekly, days: 2 }));
    expect(starts(r1, 0)).toEqual(["22:00", "23:00"]);
    expect(starts(r1, 1)).toEqual(["00:00", "01:00"]);
    const r2 = computeAvailability(base({ weekly, days: 2, busy: [{ start: tpe(MON, "23:00"), end: tpe("2026-10-20", "01:00") }] }));
    expect(starts(r2, 0)).toEqual(["22:00"]);
    expect(starts(r2, 1)).toEqual(["01:00"]);
  });
  it("跨年（12/31 → 1/1）星期正確", () => {
    expect(weekdayOf("2027-01-01")).toBe(5);
    const r = computeAvailability(base({ now: tpe("2026-12-30", "00:00"), fromDate: "2026-12-31", days: 2, weekly: [{ weekday: 5, startMin: 600, endMin: 660 }] }));
    expect(r.map((d) => d.slots.length)).toEqual([0, 1]);
  });
});

describe("例外日", () => {
  it("closed 蓋掉當天每週時段", () => {
    expect(computeAvailability(base({ overrides: [{ date: MON, kind: "closed" }] }))[0]!.slots).toEqual([]);
  });
  it("open 加開（可在沒排班的日子）", () => {
    expect(starts(computeAvailability(base({ fromDate: "2026-10-20", overrides: [{ date: "2026-10-20", kind: "open", startMin: 14 * 60, endMin: 16 * 60 }] })))).toEqual(["14:00", "15:00"]);
  });
  it("closed＋open 同一天＝只開加開的時段（例如只上半天）", () => {
    expect(starts(computeAvailability(base({ overrides: [{ date: MON, kind: "closed" }, { date: MON, kind: "open", startMin: 10 * 60, endMin: 11 * 60 }] })))).toEqual(["10:00"]);
  });
  it("別天的例外不影響今天", () => {
    expect(starts(computeAvailability(base({ overrides: [{ date: "2026-10-26", kind: "closed" }] })))).toEqual(["09:00", "10:00", "11:00"]);
  });
});

describe("已預約衝突、最早／最遠", () => {
  it("已預約的時段與重疊的時段不可約", () => {
    expect(starts(computeAvailability(base({ stepMin: 30, busy: [{ start: tpe(MON, "10:00"), end: tpe(MON, "11:00") }] })))).toEqual(["09:00", "11:00"]);
  });
  it("最早可約：現在 08:00、提前 120 分 → 10:00 起", () => {
    expect(starts(computeAvailability(base({ now: tpe(MON, "08:00") })))).toEqual(["10:00", "11:00"]);
  });
  it("最遠可約：超過 maxAdvanceDays 的日子沒有時段", () => {
    const r = computeAvailability(base({ now: tpe("2026-10-18", "12:00"), fromDate: "2026-10-26", maxAdvanceDays: 7 }));
    expect(r).toHaveLength(0);
  });
  it("isBookable：只有算得出來的開始時間可約（時間差 1 分鐘也不行）", () => {
    const input = base();
    expect(isBookable(input, tpe(MON, "10:00").toISOString())).not.toBeNull();
    expect(isBookable(input, tpe(MON, "10:01").toISOString())).toBeNull();
    expect(isBookable({ ...input, busy: [{ start: tpe(MON, "10:00"), end: tpe(MON, "11:00") }] }, tpe(MON, "10:00").toISOString())).toBeNull();
  });
});

describe("自助取消期限與 HH:MM", () => {
  it("開始前 24 小時以前可以，之後不行", () => {
    const start = tpe(MON, "10:00");
    expect(canSelfCancel(start, new Date(start.getTime() - 25 * 3600_000), 24)).toBe(true);
    expect(canSelfCancel(start, new Date(start.getTime() - 24 * 3600_000), 24)).toBe(true);
    expect(canSelfCancel(start, new Date(start.getTime() - 23 * 3600_000), 24)).toBe(false);
    expect(canSelfCancel(start, new Date(start.getTime() - 60_000), 0)).toBe(true);
  });
  it("parseHm", () => {
    expect(parseHm("09:30")).toBe(570);
    expect(parseHm("24:00")).toBe(1440);
    expect(parseHm("24:30")).toBeNaN();
    expect(parseHm("9:7")).toBeNaN();
  });
});

describe(".ics", () => {
  it("CRLF、UTC 時間、跳脫、折行、取消用 METHOD:CANCEL", () => {
    const ics = buildIcs({ uid: "booking-1@gb", start: tpe(MON, "10:00"), end: tpe(MON, "11:00"), summary: "諮詢, 60 分; 台北", description: "第一行\n第二行", location: "台北市" }, new Date("2026-10-18T00:00:00Z"));
    expect(ics).toContain("\r\nDTSTART:20261019T020000Z\r\n");
    expect(ics).toContain("DTEND:20261019T030000Z");
    expect(ics).toContain("SUMMARY:諮詢\\, 60 分\\; 台北");
    expect(ics).toContain("DESCRIPTION:第一行\\n第二行");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(buildIcs({ uid: "x", start: MON, end: MON, summary: "x", cancelled: true })).toContain("METHOD:CANCEL");
    const long = foldLine(`DESCRIPTION:${"預約".repeat(40)}`);
    expect(long.split("\r\n ").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(icsEscape("a\\b")).toBe("a\\\\b");
  });
});
