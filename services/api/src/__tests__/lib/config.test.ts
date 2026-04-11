describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should parse valid environment variables", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.NODE_ENV = "test";

    const { config } = require("../../lib/config");

    expect(config.JWT_SECRET).toBe("test-secret");
    expect(config.DATABASE_URL).toBe("postgresql://localhost:5432/test");
    expect(config.NODE_ENV).toBe("test");
  });

  it("should apply defaults for optional fields", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.NODE_ENV = "test";

    const { config } = require("../../lib/config");

    expect(config.PORT).toBe(8000);
    expect(config.FRONTEND_URL).toBe(
      "https://delphi-atlas.vercel.app,https://atlas-staging.vercel.app,http://localhost:3000",
    );
    expect(config.GEMINI_MODEL).toBe("gemini-2.5-flash");
  });

  it("should coerce PORT to number", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.PORT = "3000";
    process.env.NODE_ENV = "test";

    const { config } = require("../../lib/config");

    expect(config.PORT).toBe(3000);
    expect(typeof config.PORT).toBe("number");
  });

  it("should allow optional AI keys to be undefined", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.NODE_ENV = "test";
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const { config } = require("../../lib/config");

    expect(config.GOOGLE_AI_API_KEY).toBeFalsy();
    expect(config.XAI_API_KEY).toBeFalsy();
    expect(config.OPENAI_API_KEY).toBeFalsy();
    expect(config.ANTHROPIC_API_KEY).toBeFalsy();
  });

  it("should use dev fallback when JWT_SECRET missing in non-production", () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://localhost:5432/test";

    const { config } = require("../../lib/config");

    expect(config.JWT_SECRET).toBe("dev-only-secret-do-not-use-in-production");
  });

  describe("GitHub env vars (#3949)", () => {
    it("treats GITHUB_TOKEN/OWNER/REPO as optional", () => {
      process.env.JWT_SECRET = "test-secret";
      process.env.DATABASE_URL = "postgresql://localhost:5432/test";
      process.env.NODE_ENV = "test";
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_OWNER;
      delete process.env.GITHUB_REPO;

      const { config } = require("../../lib/config");

      // Config does not crash, values are undefined. Loop handlers fall
      // back to DEFAULT_GITHUB_* constants at request time.
      expect(config.GITHUB_TOKEN).toBeUndefined();
      expect(config.GITHUB_OWNER).toBeUndefined();
      expect(config.GITHUB_REPO).toBeUndefined();
    });

    it("passes through GITHUB_OWNER when the env var is set", () => {
      process.env.JWT_SECRET = "test-secret";
      process.env.DATABASE_URL = "postgresql://localhost:5432/test";
      process.env.NODE_ENV = "test";
      process.env.GITHUB_OWNER = "delphi-digital";
      process.env.GITHUB_REPO = "atlas-backend";
      process.env.GITHUB_TOKEN = "ghp_fake_token";

      const { config } = require("../../lib/config");

      expect(config.GITHUB_OWNER).toBe("delphi-digital");
      expect(config.GITHUB_REPO).toBe("atlas-backend");
      expect(config.GITHUB_TOKEN).toBe("ghp_fake_token");
    });

    it("exports DEFAULT_GITHUB_OWNER and DEFAULT_GITHUB_REPO constants", () => {
      process.env.JWT_SECRET = "test-secret";
      process.env.DATABASE_URL = "postgresql://localhost:5432/test";
      process.env.NODE_ENV = "test";

      const { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_REPO } = require("../../lib/config");

      // These values mirror .env.example and are the single source of
      // truth for the loop PR creation fallback. If the canonical repo
      // moves to a different org, bump BOTH here and .env.example in
      // the same commit — don't let them drift apart.
      expect(DEFAULT_GITHUB_OWNER).toBe("a13xperi");
      expect(DEFAULT_GITHUB_REPO).toBe("atlas-portal");
      expect(typeof DEFAULT_GITHUB_OWNER).toBe("string");
      expect(typeof DEFAULT_GITHUB_REPO).toBe("string");
    });
  });
});
