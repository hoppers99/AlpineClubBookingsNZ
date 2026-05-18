CREATE TABLE "SetupProgress" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "completedStepIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "skippedStepIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "completedAt" TIMESTAMP(3),
    "completedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SetupProgress_pkey" PRIMARY KEY ("id")
);
