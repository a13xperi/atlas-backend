import {
  buildArenaLeaderboard,
  calculateConsistencyStreak,
  getDraftTotalEngagement,
  type ArenaPublishedDraft,
  type ArenaUser,
} from "../../lib/arena";

describe("arena helpers", () => {
  it("computes a day-based consistency streak from unique posting days", () => {
    const streak = calculateConsistencyStreak([
      new Date("2026-04-09T10:00:00Z"),
      new Date("2026-04-09T18:30:00Z"),
      new Date("2026-04-08T09:00:00Z"),
      new Date("2026-04-07T21:00:00Z"),
      new Date("2026-04-05T12:00:00Z"),
    ]);

    expect(streak).toBe(3);
  });

  it("prefers stored engagement metrics and falls back to predicted engagement when missing", () => {
    expect(getDraftTotalEngagement({
      engagementMetrics: {
        likes: 18,
        retweets: 7,
        replies: 5,
      },
      predictedEngagement: 99,
    })).toBe(30);

    expect(getDraftTotalEngagement({
      engagementMetrics: null,
      predictedEngagement: 42.4,
    })).toBe(42);
  });

  it("builds ranked leaderboard entries and keeps the requesting user in view", () => {
    const users: ArenaUser[] = [
      { id: "user-1", handle: "alice", displayName: "Alice", avatarUrl: null },
      { id: "user-2", handle: "bruno", displayName: "Bruno", avatarUrl: null },
      { id: "user-3", handle: "casey", displayName: "Casey", avatarUrl: null },
    ];

    const publishedDrafts: ArenaPublishedDraft[] = [
      {
        id: "draft-1",
        userId: "user-1",
        publishedAt: new Date("2026-04-09T12:00:00Z"),
        engagementMetrics: { likes: 12, retweets: 4, replies: 2 },
      },
      {
        id: "draft-2",
        userId: "user-1",
        publishedAt: new Date("2026-04-08T12:00:00Z"),
        engagementMetrics: { likes: 10, retweets: 3, replies: 1 },
      },
      {
        id: "draft-3",
        userId: "user-1",
        publishedAt: new Date("2026-04-07T12:00:00Z"),
        engagementMetrics: { likes: 8, retweets: 2, replies: 1 },
      },
      {
        id: "draft-4",
        userId: "user-2",
        publishedAt: new Date("2026-04-06T12:00:00Z"),
        engagementMetrics: { likes: 40, retweets: 10, replies: 4 },
      },
      {
        id: "draft-5",
        userId: "user-3",
        publishedAt: new Date("2026-04-05T12:00:00Z"),
        predictedEngagement: 18,
      },
    ];

    const result = buildArenaLeaderboard({
      users,
      publishedDrafts,
      requestingUserId: "user-3",
    });

    expect(result.period).toBe("last_30_days");
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({
      rank: 1,
      userId: "user-1",
      tweetsPublished: 3,
      totalEngagement: 43,
      consistencyStreak: 3,
    });
    expect(result.entries[1]).toMatchObject({
      rank: 2,
      userId: "user-2",
      totalEngagement: 54,
    });
    expect(result.userRank).toMatchObject({
      userId: "user-3",
      rank: 3,
      totalEngagement: 18,
      tweetsPublished: 1,
    });
  });
});
