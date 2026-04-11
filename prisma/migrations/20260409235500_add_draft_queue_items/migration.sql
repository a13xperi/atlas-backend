-- CreateTable
CREATE TABLE "draft_queue_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'queued',
    "platform" TEXT NOT NULL DEFAULT 'twitter',
    "tweetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "draft_queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "draft_queue_items_userId_status_idx" ON "draft_queue_items"("userId", "status");

-- CreateIndex
CREATE INDEX "draft_queue_items_status_scheduledAt_idx" ON "draft_queue_items"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "draft_queue_items_userId_createdAt_idx" ON "draft_queue_items"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "draft_queue_items" ADD CONSTRAINT "draft_queue_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
