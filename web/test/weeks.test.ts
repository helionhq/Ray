import { describe, expect, it } from "vitest";
import {
  SECONDS_PER_WEEK,
  isoFromUnixSeconds,
  weekBounds,
  weekStartSeconds,
} from "../worker/lib/weeks";

function utc(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

describe("weekStartSeconds", () => {
  it("returns the same instant for Monday 00:00:00 UTC", () => {
    const monday = utc("2026-11-02T00:00:00Z");
    expect(weekStartSeconds(monday)).toBe(monday);
  });

  it("keeps Monday 00:00:00 in the new week, not the previous one", () => {
    const previousSunday = utc("2026-11-01T23:59:59Z");
    const monday = utc("2026-11-02T00:00:00Z");
    expect(weekStartSeconds(previousSunday)).toBe(
      utc("2026-10-26T00:00:00Z"),
    );
    expect(weekStartSeconds(monday)).toBe(monday);
  });

  it("keeps Sunday 23:59:59 in the week that started Monday", () => {
    const sunday = utc("2026-11-08T23:59:59Z");
    expect(weekStartSeconds(sunday)).toBe(utc("2026-11-02T00:00:00Z"));
  });

  it("moves to a new week at Monday 00:00:00 UTC", () => {
    expect(weekStartSeconds(utc("2026-11-09T00:00:00Z"))).toBe(
      utc("2026-11-09T00:00:00Z"),
    );
    const justBefore = utc("2026-11-08T23:59:59Z");
    expect(weekStartSeconds(justBefore)).not.toBe(
      weekStartSeconds(utc("2026-11-09T00:00:00Z")),
    );
  });

  it("matches the contract example bounds", () => {
    const bounds = weekBounds(utc("2026-11-05T12:34:56Z"));
    expect(isoFromUnixSeconds(bounds.weekStart)).toBe(
      "2026-11-02T00:00:00Z",
    );
    expect(isoFromUnixSeconds(bounds.resetsAt)).toBe(
      "2026-11-09T00:00:00Z",
    );
  });

  it("handles dates before the epoch", () => {
    // 1970-01-01 was a Thursday; that week started 1969-12-29.
    expect(weekStartSeconds(0)).toBe(utc("1969-12-29T00:00:00Z"));
    expect(weekStartSeconds(-1)).toBe(utc("1969-12-29T00:00:00Z"));
  });

  it("returns a seven-day span", () => {
    const bounds = weekBounds(utc("2026-11-05T12:34:56Z"));
    expect(bounds.resetsAt - bounds.weekStart).toBe(SECONDS_PER_WEEK);
  });

  it("is stable for every second of a week", () => {
    const start = utc("2026-11-02T00:00:00Z");
    for (const offset of [0, 1, 86_399, 86_400, 604_799]) {
      expect(weekStartSeconds(start + offset)).toBe(start);
    }
    expect(weekStartSeconds(start + 604_800)).toBe(start + 604_800);
  });

  it("guards against non-finite timestamps", () => {
    expect(weekStartSeconds(Number.NaN)).toBe(0);
  });
});
