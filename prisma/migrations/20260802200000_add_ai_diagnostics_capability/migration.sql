-- AI Diagnostics capability (AID-2, #2371, epic #2369): the aiDiagnostics module
-- flag plus the four deployment-local metering/config tables for a SEPARATE,
-- admin-only paid diagnostics product. Nothing here is shared with the page-help
-- AiAssistant* tables above.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * ALTER TABLE "ClubModuleSettings" ADD COLUMN "aiDiagnostics" BOOLEAN NOT NULL
--    DEFAULT false — a PostgreSQL metadata-only ADD COLUMN with a constant
--    default (no table rewrite, no row scan) on the cold ClubModuleSettings
--    catalog singleton, taking a brief ACCESS EXCLUSIVE lock on a one-row table.
--    The previously deployed (old-colour) client reads ClubModuleSettings only
--    through CLUB_MODULE_SETTINGS_COLUMN_SELECT, which does not name the new
--    column, so the flag is invisible to it through the migrate -> cutover drain.
--  * Four brand-new COLD tables (DiagnosticsSettings, DiagnosticsUsageMonthly,
--    DiagnosticsBudgetReservation, DiagnosticsUsageEvent) with plain btree
--    indexes and NO foreign keys — no table exists a moment before its own
--    CREATE, so the CREATE/index only lock objects that did not exist. NO row is
--    seeded: the settings singleton is created lazily on first WRITE, and every
--    read synthesises the schema default (budget 0 = hard-off) on a miss.
--
-- Purely additive / expand-safe: no enum change, no DROP, no RENAME, no
-- ALTER COLUMN TYPE / SET NOT NULL on existing data, no backfill DML, no
-- session-clock DML, and no provider call. None of the new tables is a hot table
-- and none is in HOT_TABLE_SQL_REGEX; deliberately no foreign key (updatedByMemberId
-- / adminMemberId are plain strings, the same shape as AiAssistantUsageEvent.memberId)
-- so the FK case of the blue/green gate is not tripped and this metering can never
-- block a Member delete or schema change. Forward-only expand (no automated
-- rollback needed): dropping the tables/column on rollback discards only the
-- club's diagnostics on/off choice and its metering history.
--
-- DEFAULT false on the flag AND budget default 0 on DiagnosticsSettings are the
-- fail-closed guarantee: every existing club keeps diagnostics off, and even a
-- club that later flips the module on cannot spend until it explicitly sets a
-- dedicated credential and a positive budget.

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "aiDiagnostics" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DiagnosticsSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "monthlyBudgetCents" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByMemberId" TEXT,

    CONSTRAINT "DiagnosticsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticsUsageMonthly" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "roundtripCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "settledCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticsUsageMonthly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticsBudgetReservation" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "reservedCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticsBudgetReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticsUsageEvent" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "adminMemberId" TEXT,
    "surface" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "roundIndex" INTEGER,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiagnosticsUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticsUsageMonthly_month_key" ON "DiagnosticsUsageMonthly"("month");

-- CreateIndex
CREATE INDEX "DiagnosticsBudgetReservation_month_expiresAt_idx" ON "DiagnosticsBudgetReservation"("month", "expiresAt");

-- CreateIndex
CREATE INDEX "DiagnosticsBudgetReservation_expiresAt_idx" ON "DiagnosticsBudgetReservation"("expiresAt");

-- CreateIndex
CREATE INDEX "DiagnosticsUsageEvent_month_idx" ON "DiagnosticsUsageEvent"("month");

-- CreateIndex
CREATE INDEX "DiagnosticsUsageEvent_createdAt_idx" ON "DiagnosticsUsageEvent"("createdAt");
