-- Which setup SURFACES this club is shown (setup wizard C8, #223; epic #213 D8;
-- INV-CONFIG-001). The wizard is the destination; the readiness cards and the
-- four /admin/setup drill-down hubs are transitional, and once the wizard covers
-- them one setting hides them. This is where that setting lives.
--
-- PURELY ADDITIVE EXPAND. One brand-new empty table and one index on it. Nothing
-- is renamed, retyped, dropped or repurposed, no existing table is read or
-- touched, and no existing row's values are rewritten. The deployed OLD code
-- knows nothing about this table and is completely unaffected, which is what
-- makes it readable by the draining colour through a blue/green cutover. Same
-- shape as 20260826010000_add_environment_safety_settings, statement for
-- statement. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the analysis.
--
-- NOT DATA-REWRITING: there is no DML at all — no INSERT, no UPDATE, no DELETE,
-- no data-modifying CTE, no DO block — so every existing row in every existing
-- table is byte-identical afterwards and no verification fixture is required
-- (scripts/check-data-migration-verification.sh classifies it as shape-only).
--
-- THE DEFAULT IS THE SAFETY PROPERTY, not a formality (#223 AC4). `false` means
-- SHOWN, so an installation that has never opened the section keeps exactly the
-- surfaces it has today, and so does one whose row is absent, whose client
-- predates this table, or whose reader could not reach the database at all. The
-- failure direction is deliberately "a surface stays visible", never "a surface
-- an operator relies on disappeared because a read failed".
--
-- THE ROW IS DELIBERATELY NOT SEEDED. Absent means "shown", which is the same
-- answer as legacySurfacesHidden = false, so no read path has to create a row
-- and no club is written to before it has asked for anything. Seeding would also
-- stamp an `updatedAt` and a NULL `updatedByMemberId` onto a decision nobody has
-- taken yet.
--
-- FLIPPING IT CHANGES NO DATA. The step registry, every readiness check and
-- SetupProgress are untouched in both positions, so hiding and re-showing is
-- reversible with nothing to migrate back — which is what lets the reverse below
-- be a bare DROP TABLE.

-- CreateTable
CREATE TABLE "SetupSurfaceSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "legacySurfacesHidden" BOOLEAN NOT NULL DEFAULT false,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupSurfaceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SetupSurfaceSettings_updatedByMemberId_idx" ON "SetupSurfaceSettings"("updatedByMemberId");
