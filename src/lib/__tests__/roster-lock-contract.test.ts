import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = process.cwd()
const WRITERS = [
  "src/app/api/lodge/guests/[date]/depart/route.ts",
  "src/app/api/lodge/roster/[date]/confirm/route.ts",
  "src/app/api/lodge/roster/[date]/route.ts",
  "src/lib/admin-roster-service.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/booking-modify-plan.ts",
  "src/lib/chore-cleanup.ts",
] as const

function source(file: string) {
  return fs.readFileSync(path.join(ROOT, file), "utf8")
}

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return allSourceFiles(absolute)
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : []
  })
}

describe("roster-date lock source contract (#2586)", () => {
  it("keeps every ChoreAssignment writer in the reviewed participant inventory", () => {
    const found = allSourceFiles(path.join(ROOT, "src"))
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => /choreAssignment\.(?:create|createMany|update|updateMany|delete|deleteMany)\s*\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"))
      .sort()
    expect(found).toEqual([...WRITERS].sort())
  })

  it("pins direct whole-roster and row writers to the shared roster-date lock", () => {
    expect(source("src/lib/admin-roster-service.ts")).toMatch(/await lockRosterEligibilityMutation\(tx, lodgeId, date\)/)
    expect(source("src/app/api/lodge/roster/[date]/confirm/route.ts")).toMatch(/await lockRosterEligibilityMutation\(tx, lodgeId, date\)/)
    expect(source("src/app/api/lodge/roster/[date]/route.ts")).toMatch(/await lockRosterDate\(tx, date\)/)
  })

  it("pins cleanup writers to sorted multi-date roster locks before deletion", () => {
    for (const file of [
      "src/app/api/lodge/guests/[date]/depart/route.ts",
      "src/lib/booking-guest-removal-service.ts",
      "src/lib/chore-cleanup.ts",
    ]) {
      const contents = source(file)
      expect(contents).toContain("lockRosterDates")
      expect(contents.indexOf("lockRosterDates")).toBeLessThan(contents.lastIndexOf("choreAssignment.delete"))
    }

    const dateService = source("src/lib/booking-date-modification-service.ts")
    expect(dateService.lastIndexOf("await lockRosterDateRangesAndDates(")).toBeLessThan(
      dateService.lastIndexOf("cleanupChoreAssignmentsForGuestStayRanges("),
    )
    expect(dateService).toContain("rosterDatesAlreadyLocked: true")

    const batchService = source("src/lib/booking-batch-modification-service.ts")
    expect(batchService.lastIndexOf("await lockRosterDateRangesAndDates(")).toBeLessThan(
      batchService.lastIndexOf("applyChoreCleanup("),
    )
    expect(batchService).toContain("rosterDatesAlreadyLocked: true")
  })

  it("keeps departure and chore-template mutation ordered with roster validation", () => {
    const departure = source("src/app/api/lodge/guests/[date]/depart/route.ts")
    expect(departure.indexOf("pg_advisory_xact_lock(1)")).toBeLessThan(
      departure.indexOf("acquireLodgeCapacityLock(tx, lodgeId)"),
    )
    expect(departure.indexOf("acquireLodgeCapacityLock(tx, lodgeId)")).toBeLessThan(
      departure.indexOf("await lockRosterDates"),
    )
    expect(departure.indexOf("await lockRosterDates")).toBeLessThan(
      departure.indexOf("tx.bookingGuest.update"),
    )

    const templateMutation = source("src/app/api/admin/chores/[id]/route.ts")
    expect(templateMutation).toContain("acquireLodgeCapacityLock(tx, effectiveLodgeId)")
    expect(templateMutation.indexOf("acquireLodgeCapacityLock(tx, effectiveLodgeId)")).toBeLessThan(
      templateMutation.indexOf("tx.choreTemplate.update"),
    )

    const configApply = source("src/lib/config-transfer/apply.ts")
    const configLock = configApply.indexOf("await acquireConfigImportLock(tx)")
    const importedLodgeLocks = configApply.indexOf("await lockAffectedLodgeConfigLodges(tx, parsed.files)")
    const inLockReplan = configApply.indexOf("const replan = await buildImportPlanFromParsed")
    expect(configLock).toBeGreaterThan(-1)
    expect(importedLodgeLocks).toBeGreaterThan(configLock)
    expect(inLockReplan).toBeGreaterThan(importedLodgeLocks)
    const importedLodgeLockHelper = configApply.slice(
      configApply.indexOf("async function lockAffectedLodgeConfigLodges"),
      configApply.indexOf("export type BootstrapBackupSkip"),
    )
    expect(importedLodgeLockHelper).toContain("lodges.map(({ id }) => id).sort()")
    expect(importedLodgeLockHelper).toContain("await acquireLodgeCapacityLock(tx, lodgeId)")

    const lodgeOps = source("src/lib/config-transfer/categories/lodge-ops.ts")
    expect(lodgeOps).toContain("ctx.tx.choreTemplate.update")
    expect(configApply).toContain("await acquireLodgeCapacityLock(tx, lodgeId)")
  })

  it("keeps every roster-eligibility writer on a shared global or lodge tier", () => {
    const protocols = [
      {
        file: "src/app/api/admin/bookings/[id]/review/route.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock"],
      },
      {
        file: "src/app/api/bookings/[id]/guests/route.ts",
        markers: ["acquireLodgeCapacityLock"],
      },
      {
        file: "src/lib/member-guest-consent-service.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock"],
      },
      {
        file: "src/lib/booking-guest-removal-service.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock", "lockRosterDates"],
      },
      {
        file: "src/lib/booking-date-modification-service.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock", "lockRosterDateRangesAndDates"],
      },
      {
        file: "src/lib/booking-batch-modification-service.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock", "lockRosterDateRangesAndDates"],
      },
    ]

    for (const { file, markers } of protocols) {
      const contents = source(file)
      for (const marker of markers) expect(contents, file).toContain(marker)
    }
  })

  it("keeps review eligibility positive so rejected and unresolved rows stay blocked", () => {
    const contents = source("src/lib/booking-review.ts")
    expect(contents).toContain("{ requiresAdminReview: false }")
    expect(contents).toContain("{ adminReviewStatus: AdminReviewStatus.APPROVED }")
  })

  it("keeps the public admin mutation contract free of legacy immediate row actions", () => {
    const contents = source("src/lib/admin-roster-service.ts")
    expect(contents).not.toContain('z.literal("reassign")')
    expect(contents).not.toContain('z.literal("add")')
    expect(contents).not.toContain('z.literal("remove")')
    expect(contents).toContain('action: z.literal("save")')
  })
})
