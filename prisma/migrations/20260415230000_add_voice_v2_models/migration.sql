-- AlterTable
ALTER TABLE "briefing_preferences" ADD COLUMN     "briefType" TEXT NOT NULL DEFAULT 'morning',
ADD COLUMN     "lastDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT;

-- CreateTable
CREATE TABLE "trending_topics" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "keywords" TEXT[],
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "url" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trending_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bugs" (
    "id" TEXT NOT NULL,
    "bugNumber" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pageRoute" TEXT,
    "pageUrl" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "source" TEXT,
    "project" TEXT,
    "foundBy" TEXT,
    "fixedBy" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "fingerprint" TEXT,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "userAgent" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "fixedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bugs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_swipe_signals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "handle" TEXT,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_swipe_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trending_topics_createdAt_idx" ON "trending_topics"("createdAt");

-- CreateIndex
CREATE INDEX "voice_swipe_signals_userId_idx" ON "voice_swipe_signals"("userId");

-- AddForeignKey
ALTER TABLE "voice_swipe_signals" ADD CONSTRAINT "voice_swipe_signals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
