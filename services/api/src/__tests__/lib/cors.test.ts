import type { CorsOptions } from "cors";
import {
  assertCorsConfig,
  buildCorsOptions,
  buildOriginMatcher,
  DEFAULT_ALLOWED_HEADERS,
  DEFAULT_ALLOWED_METHODS,
  DEFAULT_EXPOSED_HEADERS,
} from "../../lib/cors";

/**
 * Extract the `origin` callback from a CorsOptions so we can exercise it
 * like cors itself would — `(origin, cb)` where the second arg reports
 * `(err, allow)`. Keeps tests decoupled from the cors middleware surface.
 */
function originResolver(opts: CorsOptions) {
  const origin = opts.origin;
  if (typeof origin !== "function") {
    throw new Error("expected origin to be a function");
  }
  return (incoming: string | undefined) =>
    new Promise<{ err: Error | null; allow: boolean | string | RegExp | undefined }>((resolve) => {
      // cors's origin-callback signature: (err, allow)
      const cb = (err: Error | null, allow?: boolean | string | RegExp) => {
        resolve({ err, allow });
      };
      // The real cors package passes `undefined` when there is no Origin
      // header — match that exactly.
      (origin as (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean | string | RegExp) => void,
      ) => void)(incoming, cb);
    });
}

describe("buildOriginMatcher — regex metacharacter escaping (Bug #1)", () => {
  it("treats `.` in an allowlist entry as a literal, not any-char", () => {
    const match = buildOriginMatcher(["https://*.vercel.app"]);

    // Legit preview subdomain — must still match.
    expect(match("https://preview.vercel.app")).toBe(true);
    expect(match("https://feature-branch.vercel.app")).toBe(true);

    // The old regex (unescaped `.`) would let this through because
    // `.vercel.app` would match the literal string `xvercelxapp`.
    expect(match("https://x.vercelxapp")).toBe(false);
    expect(match("https://preview-vercelxapp")).toBe(false);
  });

  it("escapes other regex metacharacters in literal entries", () => {
    // `?` and `+` would otherwise alter the regex semantics. We want a
    // literal string match for entries without `*`.
    const match = buildOriginMatcher([
      "https://foo.app?q=1",
      "https://weird+host.test",
    ]);

    expect(match("https://foo.app?q=1")).toBe(true);
    expect(match("https://weird+host.test")).toBe(true);

    // Without escaping, `?` would make the prior char optional and accept
    // `https://foo.ap`.
    expect(match("https://foo.ap")).toBe(false);
    // Without escaping, `+` would make `t` one-or-more.
    expect(match("https://weirdhost.test")).toBe(false);
  });

  it("anchors patterns so partial matches are rejected", () => {
    const match = buildOriginMatcher(["https://*.vercel.app"]);
    expect(match("https://preview.vercel.app.evil.com")).toBe(false);
    expect(match("http://preview.vercel.app")).toBe(false);
  });

  it("handles exact-match entries", () => {
    const match = buildOriginMatcher(["https://delphi-atlas.vercel.app"]);
    expect(match("https://delphi-atlas.vercel.app")).toBe(true);
    expect(match("https://delphi-atlas.vercel.app/")).toBe(false);
    expect(match("https://evil.com")).toBe(false);
  });
});

describe("buildCorsOptions — origin callback (Bug #2)", () => {
  const allow = ["https://delphi-atlas.vercel.app", "https://*.vercel.app"];

  it("rejects no-origin requests explicitly instead of silently allowing", async () => {
    const opts = buildCorsOptions(allow);
    const resolve = originResolver(opts);

    const { err, allow: verdict } = await resolve(undefined);
    expect(err).toBeNull();
    // The old code returned `true` here — that meant any tool without an
    // Origin header (including curl, server-to-server) was handed full
    // CORS credentials. Explicit `false` is the correct answer.
    expect(verdict).toBe(false);
  });

  it("rejects unknown origins with callback(null, false) — never undefined", async () => {
    const opts = buildCorsOptions(allow);
    const resolve = originResolver(opts);

    const { err, allow: verdict } = await resolve("https://evil.com");
    expect(err).toBeNull();
    // Specifically NOT `undefined` — that was the original bug.
    expect(verdict).toBe(false);
    expect(verdict).not.toBeUndefined();
  });

  it("accepts exact-match origins", async () => {
    const opts = buildCorsOptions(allow);
    const resolve = originResolver(opts);

    const { err, allow: verdict } = await resolve("https://delphi-atlas.vercel.app");
    expect(err).toBeNull();
    expect(verdict).toBe(true);
  });

  it("accepts wildcard-match origins", async () => {
    const opts = buildCorsOptions(allow);
    const resolve = originResolver(opts);

    const { err, allow: verdict } = await resolve("https://feature-xyz.vercel.app");
    expect(err).toBeNull();
    expect(verdict).toBe(true);
  });

  it("still rejects near-miss wildcard origins after metachar escape", async () => {
    const opts = buildCorsOptions(allow);
    const resolve = originResolver(opts);

    const { allow: verdict } = await resolve("https://x.vercelxapp");
    expect(verdict).toBe(false);
  });
});

describe("assertCorsConfig — boot-time guard (Bug #3)", () => {
  it("throws in production if the allowlist is empty", () => {
    expect(() =>
      assertCorsConfig({ allowedOrigins: [], nodeEnv: "production" }),
    ).toThrow(/FRONTEND_URL is empty in production/);
  });

  it("is a no-op in development with an empty allowlist", () => {
    expect(() =>
      assertCorsConfig({ allowedOrigins: [], nodeEnv: "development" }),
    ).not.toThrow();
  });

  it("is a no-op in staging with an empty allowlist", () => {
    // Staging deploys occasionally boot before FRONTEND_URL is wired up —
    // don't let the guard take down the staging API.
    expect(() =>
      assertCorsConfig({ allowedOrigins: [], nodeEnv: "staging" }),
    ).not.toThrow();
  });

  it("is a no-op in production when at least one origin is configured", () => {
    expect(() =>
      assertCorsConfig({
        allowedOrigins: ["https://delphi-atlas.vercel.app"],
        nodeEnv: "production",
      }),
    ).not.toThrow();
  });
});

describe("buildCorsOptions — explicit methods / headers hardening", () => {
  const opts = buildCorsOptions(["https://delphi-atlas.vercel.app"]);

  it("declares an explicit methods allowlist", () => {
    expect(opts.methods).toEqual(DEFAULT_ALLOWED_METHODS);
    expect(opts.methods).toEqual(
      expect.arrayContaining(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
    );
  });

  it("declares an explicit allowedHeaders list", () => {
    expect(opts.allowedHeaders).toEqual(DEFAULT_ALLOWED_HEADERS);
    expect(opts.allowedHeaders).toEqual(
      expect.arrayContaining(["Content-Type", "Authorization", "X-Request-Id"]),
    );
  });

  it("exposes the request-id header so the client can correlate logs", () => {
    expect(opts.exposedHeaders).toEqual(DEFAULT_EXPOSED_HEADERS);
    expect(opts.exposedHeaders).toContain("X-Request-Id");
  });

  it("keeps credentials enabled", () => {
    expect(opts.credentials).toBe(true);
  });

  it("sets a reasonable preflight cache maxAge", () => {
    expect(opts.maxAge).toBeGreaterThan(0);
  });
});
