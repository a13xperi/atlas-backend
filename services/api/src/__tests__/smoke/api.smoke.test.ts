/**
 * E2E Smoke Tests — hit real production endpoints.
 * Run: DATABASE_URL=<prod> npx jest --testPathPattern smoke
 * These tests use the seeded demo account (maya-demo).
 */

const SMOKE_ENABLED = process.env.SMOKE_API_URL || process.env.ENABLE_PROD_SMOKE === "true";

const API = process.env.SMOKE_API_URL || "https://api-production-9bef.up.railway.app";
const DEMO_EMAIL = "maya.demo@delphidigital.io";
const DEMO_PASSWORD = "AtlasDemo2026!";

let token: string;

async function api(path: string, opts: RequestInit = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const json = await res.json();
  return { status: res.status, json };
}

const d = SMOKE_ENABLED ? describe : describe.skip;
d("E2E Smoke Tests", () => {
  // Auth flow
  describe("Auth", () => {
    it("POST /api/auth/login — logs in demo user", async () => {
      const { status, json } = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      });
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.token).toBeDefined();
      expect(json.data.user.handle).toBe("maya-demo");
      token = json.data.token;
    });

    it("GET /api/auth/me — returns authenticated user", async () => {
      const { status, json } = await api("/api/auth/me");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.user.handle).toBe("maya-demo");
    });

    it("GET /api/auth/me — rejects without token", async () => {
      const { status } = await api("/api/auth/me", {
        headers: { Authorization: "" },
      });
      expect(status).toBe(401);
    });
  });

  // Voice profile
  describe("Voice", () => {
    it("GET /api/voice/profile — returns voice dimensions", async () => {
      const { status, json } = await api("/api/voice/profile");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.profile).toBeDefined();
      expect(typeof json.data.profile.humor).toBe("number");
    });

    it("GET /api/voice/references — returns reference voices", async () => {
      const { status, json } = await api("/api/voice/references");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      const refs = json.data?.voices ?? json.data?.references;
      expect(Array.isArray(refs)).toBe(true);
    });

    it("GET /api/voice/blends — returns saved blends", async () => {
      const { status, json } = await api("/api/voice/blends");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data.blends)).toBe(true);
    });
  });

  // Drafts
  describe("Drafts", () => {
    let draftId: string;

    it("GET /api/drafts — lists drafts", async () => {
      const { status, json } = await api("/api/drafts");
      expect(status).toBe(200);
      const drafts = json.data?.drafts ?? json.drafts;
      expect(Array.isArray(drafts)).toBe(true);
      expect(drafts.length).toBeGreaterThan(0);
      draftId = drafts[0].id;
    });

    it("GET /api/drafts/:id — gets single draft", async () => {
      const { status, json } = await api(`/api/drafts/${draftId}`);
      expect(status).toBe(200);
      const draft = json.data?.draft ?? json.draft;
      expect(draft.id).toBe(draftId);
    });
  });

  // Analytics
  describe("Analytics", () => {
    it("GET /api/analytics/summary — returns summary stats", async () => {
      const { status, json } = await api("/api/analytics/summary");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.summary).toBeDefined();
      expect(typeof json.data.summary.draftsCreated).toBe("number");
    });

    it("GET /api/analytics/engagement-daily — returns daily engagement", async () => {
      const { status, json } = await api("/api/analytics/engagement-daily");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data.days)).toBe(true);
    });

    it("GET /api/analytics/activity-daily — returns daily activity", async () => {
      const { status, json } = await api("/api/analytics/activity-daily");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data.days)).toBe(true);
    });

    it("GET /api/analytics/learning-log — returns learning entries", async () => {
      const { status, json } = await api("/api/analytics/learning-log");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data.entries)).toBe(true);
    });
  });

  // Alerts
  describe("Alerts", () => {
    it("GET /api/alerts/feed — returns alert feed", async () => {
      const { status, json } = await api("/api/alerts/feed");
      expect(status).toBe(200);
      const alerts = json.data?.alerts ?? json.alerts;
      expect(Array.isArray(alerts)).toBe(true);
    });

    it("GET /api/alerts/subscriptions — returns subscriptions", async () => {
      const { status, json } = await api("/api/alerts/subscriptions");
      expect(status).toBe(200);
      const subs = json.data?.subscriptions ?? json.subscriptions;
      expect(Array.isArray(subs)).toBe(true);
    });
  });

  // Users
  describe("Users", () => {
    it("GET /api/users/profile — returns user profile", async () => {
      const { status, json } = await api("/api/users/profile");
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.user).toBeDefined();
    });
  });

  // Health
  describe("Infrastructure", () => {
    it("GET /health — returns healthy status", async () => {
      const { status, json } = await api("/health");
      expect(status).toBe(200);
      expect(json.status).toBe("ok");
    });

    it("GET /api/docs/ — Swagger UI loads", async () => {
      const res = await fetch(`${API}/api/docs/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });
  });
});
