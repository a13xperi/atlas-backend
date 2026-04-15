type ReferenceVoiceAccount = {
  id: string;
  userId: string | null;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  category: string | null;
  isActive: boolean;
  isGlobal: boolean;
  createdAt: Date;
};

type BlendVoiceWithReference = {
  id: string;
  blendId: string;
  referenceVoiceId: string | null;
  label: string;
  percentage: number;
  referenceVoice: ReferenceVoiceAccount | null;
};

type ReferenceVoiceFallbackUser = {
  id: string;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
};

export function withSafeReferenceVoice<T extends BlendVoiceWithReference>(
  voice: T,
  user: ReferenceVoiceFallbackUser,
): Omit<T, "referenceVoice"> & { referenceVoice: ReferenceVoiceAccount } {
  if (voice.referenceVoice) {
    return {
      ...voice,
      referenceVoice: voice.referenceVoice,
    };
  }

  return {
    ...voice,
    referenceVoice: {
      id: `self:${user.id}`,
      userId: user.id,
      name: voice.label || user.displayName || user.handle || "My voice",
      handle: user.handle,
      avatarUrl: user.avatarUrl,
      category: null,
      isActive: true,
      isGlobal: false,
      createdAt: new Date(0),
    },
  };
}
