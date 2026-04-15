import { withSafeReferenceVoice } from "../../lib/reference-accounts";

describe("withSafeReferenceVoice", () => {
  it("does not throw when referenceVoice is null and falls back to the user account", () => {
    expect(() =>
      withSafeReferenceVoice(
        {
          id: "voice-1",
          blendId: "blend-1",
          referenceVoiceId: null,
          label: "My voice",
          percentage: 60,
          referenceVoice: null,
        },
        {
          id: "user-123",
          displayName: "Atlas Analyst",
          handle: "atlasanalyst",
          avatarUrl: "https://example.com/me.png",
        },
      ),
    ).not.toThrow();

    const voice = withSafeReferenceVoice(
      {
        id: "voice-1",
        blendId: "blend-1",
        referenceVoiceId: null,
        label: "My voice",
        percentage: 60,
        referenceVoice: null,
      },
      {
        id: "user-123",
        displayName: "Atlas Analyst",
        handle: "atlasanalyst",
        avatarUrl: "https://example.com/me.png",
      },
    );

    expect(voice.referenceVoice).toEqual(
      expect.objectContaining({
        id: "self:user-123",
        userId: "user-123",
        name: "My voice",
        handle: "atlasanalyst",
        avatarUrl: "https://example.com/me.png",
      }),
    );
  });
});
