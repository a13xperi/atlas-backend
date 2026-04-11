jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import crypto from "node:crypto";
import {
  __resetKeyCacheForTests,
  buildTokenClear,
  buildTokenWrite,
  decryptToken,
  encryptToken,
  encryptionEnabled,
  isEncrypted,
  readAccessToken,
  readRefreshToken,
} from "../../lib/crypto";

const ORIGINAL_KEY = process.env.TOKEN_ENCRYPTION_KEY;

function setKey(key: string | undefined): void {
  if (key === undefined) {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  } else {
    process.env.TOKEN_ENCRYPTION_KEY = key;
  }
  __resetKeyCacheForTests();
}

describe("crypto (XOAuth token encryption)", () => {
  afterAll(() => {
    setKey(ORIGINAL_KEY);
  });

  describe("with encryption disabled (no key)", () => {
    beforeEach(() => setKey(undefined));

    it("encryptionEnabled() returns false", () => {
      expect(encryptionEnabled()).toBe(false);
    });

    it("encryptToken() passes plaintext through unchanged", () => {
      expect(encryptToken("hello")).toBe("hello");
    });

    it("decryptToken() passes plaintext through unchanged", () => {
      expect(decryptToken("hello")).toBe("hello");
    });

    it("buildTokenWrite() writes to plaintext columns only", () => {
      const write = buildTokenWrite({
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: new Date("2026-01-01"),
      });
      expect(write.xAccessToken).toBe("at");
      expect(write.xRefreshToken).toBe("rt");
      expect(write.xAccessTokenEnc).toBeNull();
      expect(write.xRefreshTokenEnc).toBeNull();
      expect(write.xTokenExpiresAt).toEqual(new Date("2026-01-01"));
    });

    it("readAccessToken() prefers plaintext column when enc is absent", () => {
      expect(readAccessToken({ xAccessToken: "plain", xAccessTokenEnc: null })).toBe(
        "plain",
      );
    });
  });

  describe("with encryption enabled (hex key)", () => {
    const hexKey = crypto.randomBytes(32).toString("hex");

    beforeEach(() => setKey(hexKey));

    it("encryptionEnabled() returns true", () => {
      expect(encryptionEnabled()).toBe(true);
    });

    it("encrypt → decrypt roundtrips", () => {
      const plaintext = "my-oauth-access-token-abc123";
      const encrypted = encryptToken(plaintext);
      expect(isEncrypted(encrypted)).toBe(true);
      expect(encrypted.startsWith("v1:")).toBe(true);
      expect(encrypted).not.toContain(plaintext);
      expect(decryptToken(encrypted)).toBe(plaintext);
    });

    it("produces a fresh IV per encryption (ciphertexts differ)", () => {
      const a = encryptToken("same-input");
      const b = encryptToken("same-input");
      expect(a).not.toBe(b);
      expect(decryptToken(a)).toBe("same-input");
      expect(decryptToken(b)).toBe("same-input");
    });

    it("decryptToken() throws on tampered ciphertext", () => {
      const encrypted = encryptToken("secret");
      const parts = encrypted.split(":");
      // Flip a byte in the ciphertext segment
      const tampered = Buffer.from(parts[3], "base64");
      tampered[0] = tampered[0] ^ 0xff;
      parts[3] = tampered.toString("base64");
      expect(() => decryptToken(parts.join(":"))).toThrow();
    });

    it("decryptToken() passes plaintext through unchanged", () => {
      expect(decryptToken("legacy-plaintext")).toBe("legacy-plaintext");
    });

    it("buildTokenWrite() writes to enc columns only, clearing plaintext", () => {
      const write = buildTokenWrite({
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: new Date("2026-01-01"),
      });
      expect(write.xAccessToken).toBeNull();
      expect(write.xRefreshToken).toBeNull();
      expect(write.xAccessTokenEnc).not.toBeNull();
      expect(write.xRefreshTokenEnc).not.toBeNull();
      expect(isEncrypted(write.xAccessTokenEnc!)).toBe(true);
      expect(isEncrypted(write.xRefreshTokenEnc!)).toBe(true);
      expect(decryptToken(write.xAccessTokenEnc!)).toBe("at");
      expect(decryptToken(write.xRefreshTokenEnc!)).toBe("rt");
    });

    it("buildTokenWrite() handles null refresh token gracefully", () => {
      const write = buildTokenWrite({
        accessToken: "at",
        refreshToken: null,
        expiresAt: null,
      });
      expect(write.xAccessTokenEnc).not.toBeNull();
      expect(write.xRefreshTokenEnc).toBeNull();
    });

    it("readAccessToken() prefers the enc column and decrypts it", () => {
      const enc = encryptToken("real-token");
      expect(
        readAccessToken({
          xAccessToken: "stale-plaintext",
          xAccessTokenEnc: enc,
        }),
      ).toBe("real-token");
    });

    it("readAccessToken() falls back to plaintext if enc is absent", () => {
      expect(
        readAccessToken({
          xAccessToken: "legacy-plaintext",
          xAccessTokenEnc: null,
        }),
      ).toBe("legacy-plaintext");
    });

    it("readRefreshToken() prefers the enc column and decrypts it", () => {
      const enc = encryptToken("refresh-1");
      expect(
        readRefreshToken({
          xRefreshToken: null,
          xRefreshTokenEnc: enc,
        }),
      ).toBe("refresh-1");
    });

    it("buildTokenClear() returns all-null fragment", () => {
      const clear = buildTokenClear();
      expect(clear.xAccessToken).toBeNull();
      expect(clear.xRefreshToken).toBeNull();
      expect(clear.xAccessTokenEnc).toBeNull();
      expect(clear.xRefreshTokenEnc).toBeNull();
      expect(clear.xTokenExpiresAt).toBeNull();
    });
  });

  describe("with encryption enabled (base64 key)", () => {
    const b64Key = crypto.randomBytes(32).toString("base64");

    beforeEach(() => setKey(b64Key));

    it("accepts a base64-encoded key and roundtrips", () => {
      expect(encryptionEnabled()).toBe(true);
      const encrypted = encryptToken("hello");
      expect(decryptToken(encrypted)).toBe("hello");
    });
  });

  describe("with an invalid key", () => {
    beforeEach(() => setKey("not-a-valid-32-byte-key"));

    it("encryptionEnabled() returns false (graceful fallback)", () => {
      expect(encryptionEnabled()).toBe(false);
    });

    it("encryptToken() falls through to plaintext", () => {
      expect(encryptToken("hello")).toBe("hello");
    });
  });
});
