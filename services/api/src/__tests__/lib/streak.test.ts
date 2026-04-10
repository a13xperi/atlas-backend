import { calculateStreakFromDates, toUtcDayStart } from "../../lib/streak";

describe("calculateStreakFromDates", () => {
  const NOW = new Date("2026-04-10T15:30:00Z"); // Friday, April 10, 2026

  it("returns zeroed broken state when there are no activity dates", () => {
    const result = calculateStreakFromDates([], NOW);
    expect(result).toEqual({
      currentStreak: 0,
      longestStreak: 0,
      status: "broken",
      lastActivityAt: null,
    });
  });

  it("reports an active streak when the user has activity today", () => {
    const result = calculateStreakFromDates(
      [
        new Date("2026-04-10T09:15:00Z"),
        new Date("2026-04-10T22:00:00Z"), // multiple events same day still = 1 day
        new Date("2026-04-09T18:00:00Z"),
        new Date("2026-04-08T07:00:00Z"),
        new Date("2026-04-05T12:00:00Z"), // older activity — doesn't extend the current run
      ],
      NOW,
    );

    expect(result.currentStreak).toBe(3);
    expect(result.longestStreak).toBe(3);
    expect(result.status).toBe("active");
    expect(result.lastActivityAt?.toISOString()).toBe("2026-04-10T22:00:00.000Z");
  });

  it("reports at_risk when the last activity was yesterday but not today", () => {
    const result = calculateStreakFromDates(
      [
        new Date("2026-04-09T21:45:00Z"),
        new Date("2026-04-08T08:00:00Z"),
        new Date("2026-04-07T10:00:00Z"),
      ],
      NOW,
    );

    expect(result.currentStreak).toBe(3);
    expect(result.status).toBe("at_risk");
  });

  it("reports broken when the last activity was more than one day ago", () => {
    const result = calculateStreakFromDates(
      [
        new Date("2026-04-07T10:00:00Z"),
        new Date("2026-04-06T10:00:00Z"),
        new Date("2026-04-05T10:00:00Z"),
      ],
      NOW,
    );

    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(3);
    expect(result.status).toBe("broken");
  });

  it("tracks the longest historical streak even when the current streak is shorter", () => {
    const result = calculateStreakFromDates(
      [
        // Longest historical run: 5 consecutive days (Mar 20-24)
        new Date("2026-03-20T10:00:00Z"),
        new Date("2026-03-21T10:00:00Z"),
        new Date("2026-03-22T10:00:00Z"),
        new Date("2026-03-23T10:00:00Z"),
        new Date("2026-03-24T10:00:00Z"),
        // Current run ending today: 2 days
        new Date("2026-04-09T10:00:00Z"),
        new Date("2026-04-10T10:00:00Z"),
      ],
      NOW,
    );

    expect(result.currentStreak).toBe(2);
    expect(result.longestStreak).toBe(5);
    expect(result.status).toBe("active");
  });

  it("handles duplicate-day events without double counting", () => {
    const result = calculateStreakFromDates(
      [
        new Date("2026-04-10T00:05:00Z"),
        new Date("2026-04-10T09:00:00Z"),
        new Date("2026-04-10T23:55:00Z"),
      ],
      NOW,
    );

    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
    expect(result.status).toBe("active");
  });

  it("treats days in UTC regardless of local event time-of-day", () => {
    const day1 = new Date("2026-04-09T23:59:59Z");
    const day2 = new Date("2026-04-10T00:00:01Z");
    expect(toUtcDayStart(day1)).not.toBe(toUtcDayStart(day2));

    const result = calculateStreakFromDates([day1, day2], NOW);
    expect(result.currentStreak).toBe(2);
  });
});
