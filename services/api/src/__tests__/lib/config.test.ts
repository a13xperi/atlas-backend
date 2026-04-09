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
});
