import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindMany: vi.fn(),
  assignmentFindMany: vi.fn(),
  assignmentDeleteMany: vi.fn(),
  assignmentUpdateMany: vi.fn(),
  assignmentCreate: vi.fn(),
  assignmentGroupBy: vi.fn(),
  templateFindMany: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (callback: (tx: unknown) => unknown) => mocks.transaction(callback) },
}))
vi.mock("@/lib/email", () => ({ sendChoreRosterEmail: vi.fn(), shouldSendChoreRoster: vi.fn() }))
vi.mock("@/lib/guest-chore-token", () => ({ createGuestChoreToken: vi.fn() }))
vi.mock("@/lib/member-utils", () => ({ getEffectiveEmail: vi.fn() }))
vi.mock("@/lib/logger", () => ({ default: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import {
  createRosterRevision,
  getAdminRosterForDate,
  updateAdminRosterForDate,
} from "@/lib/admin-roster-service"

const DATE = new Date("2026-08-10T00:00:00.000Z")
const CURRENT = {
  id: "assignment-1",
  choreTemplateId: "kitchen",
  bookingId: "booking-1",
  bookingGuestId: "guest-1",
  status: "CONFIRMED" as const,
  completedAt: null,
  completedVia: null,
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
}

function eligibleBooking(id: string, guestId: string, owner: string) {
  return {
    id,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    checkIn: DATE,
    checkOut: new Date("2026-08-11T00:00:00.000Z"),
    member: { firstName: owner, lastName: "Booker" },
    guests: [{
      id: guestId,
      bookingId: id,
      firstName: guestId,
      lastName: "Guest",
      ageTier: "ADULT",
      stayStart: DATE,
      stayEnd: new Date("2026-08-11T00:00:00.000Z"),
      nights: [{ stayDate: DATE }],
      member: { ageTier: "ADULT", dateOfBirth: new Date("1980-01-01T00:00:00.000Z") },
    }],
  }
}

function template(id: string, sortOrder = 1) {
  return {
    id,
    name: id,
    description: null,
    recommendedPeopleMin: 1,
    recommendedPeopleMax: 2,
    isEssential: true,
    ageRestriction: "ANY" as const,
    conditionalNote: null,
    minAge: 0,
    sortOrder,
    timeOfDay: "ANYTIME" as const,
    frequencyMode: "DAILY" as const,
    frequencyDays: null,
    frequencyDaysOfWeek: [],
    active: true,
    lodgeId: "lodge-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }
}

function tx() {
  return {
    $executeRaw: mocks.executeRaw,
    booking: { findMany: mocks.bookingFindMany },
    choreAssignment: {
      findMany: mocks.assignmentFindMany,
      deleteMany: mocks.assignmentDeleteMany,
      updateMany: mocks.assignmentUpdateMany,
      create: mocks.assignmentCreate,
      groupBy: mocks.assignmentGroupBy,
    },
    choreTemplate: { findMany: mocks.templateFindMany },
  }
}

function save(assignments: Array<{
  rowKey: string
  assignmentId?: string
  choreTemplateId: string
  bookingGuestId: string
}>, options?: { revision?: string; acknowledge?: boolean }) {
  return updateAdminRosterForDate({
    date: DATE,
    dateString: "2026-08-10",
    lodgeId: "lodge-1",
    data: {
      action: "save",
      baseRevision: options?.revision ?? createRosterRevision([CURRENT]),
      acknowledgeCompletedReset: options?.acknowledge ?? false,
      assignments,
    },
  })
}

describe("admin whole-roster save", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (callback: (client: unknown) => unknown) => callback(tx()))
    mocks.bookingFindMany.mockResolvedValue([
      eligibleBooking("booking-1", "guest-1", "One"),
      eligibleBooking("booking-2", "guest-2", "Two"),
    ])
    mocks.assignmentGroupBy.mockResolvedValue([])
    mocks.templateFindMany.mockImplementation(async (args: { select?: unknown }) =>
      args.select ? [{ id: "kitchen" }, { id: "wood" }] : [template("kitchen"), template("wood", 2)],
    )
    mocks.assignmentCreate.mockResolvedValue({ id: "assignment-new" })
    mocks.assignmentFindMany.mockImplementation(async (args: { select?: unknown; where?: { date?: unknown }; include?: unknown }) => {
      if (args.select) return [CURRENT]
      if (args.where?.date && typeof args.where.date === "object" && "gte" in (args.where.date as object)) return []
      return [{
        ...CURRENT,
        bookingId: "booking-2",
        bookingGuestId: "guest-2",
        status: "SUGGESTED",
        choreTemplate: template("kitchen"),
        bookingGuest: { firstName: "guest-2", lastName: "Guest", ageTier: "ADULT", member: { ageTier: "ADULT" } },
      }]
    })
  })

  it("reassigns across bookings by writing both foreign keys and demotes confirmed state", async () => {
    const result = await save([{ rowKey: "assignment-1", assignmentId: "assignment-1", choreTemplateId: "kitchen", bookingGuestId: "guest-2" }])
    expect(result.init).toBeUndefined()
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        bookingGuestId: "guest-2",
        bookingId: "booking-2",
        status: "SUGGESTED",
        completedAt: null,
        completedVia: null,
      }),
    }))
    expect((result.body as { assignments: Array<{ bookingId: string }> }).assignments[0].bookingId).toBe("booking-2")
  })

  it("applies remove and add in the same locked transaction while multiple assignments remain valid", async () => {
    await save([
      { rowKey: "new-1", choreTemplateId: "kitchen", bookingGuestId: "guest-2" },
      { rowKey: "new-2", choreTemplateId: "wood", bookingGuestId: "guest-2" },
    ])
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1)
    expect(mocks.assignmentDeleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["assignment-1"] } }),
    }))
    expect(mocks.assignmentCreate).toHaveBeenCalledTimes(2)
    expect(mocks.assignmentCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ bookingId: "booking-2", bookingGuestId: "guest-2" }),
    }))
  })

  it("requires completed-reset acknowledgement and clears completion only after an acknowledged save", async () => {
    const completed = { ...CURRENT, status: "COMPLETED" as const, completedAt: new Date(), completedVia: "KIOSK" }
    mocks.assignmentFindMany.mockResolvedValueOnce([completed])
    const refused = await save([
      { rowKey: "assignment-1", assignmentId: "assignment-1", choreTemplateId: "kitchen", bookingGuestId: "guest-1" },
    ], { revision: createRosterRevision([completed]) })
    expect(refused.init?.status).toBe(409)
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()

    mocks.assignmentFindMany.mockResolvedValueOnce([completed])
    await save([
      { rowKey: "assignment-1", assignmentId: "assignment-1", choreTemplateId: "kitchen", bookingGuestId: "guest-1" },
    ], { revision: createRosterRevision([completed]), acknowledge: true })
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SUGGESTED", completedAt: null, completedVia: null }),
    }))
  })

  it("rejects a stale revision under the lock with zero assignment writes", async () => {
    const result = await save([], { revision: "stale" })
    expect(result.init?.status).toBe(409)
    expect(result.body).toMatchObject({ code: "ROSTER_STALE" })
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1)
    expect(mocks.assignmentDeleteMany).not.toHaveBeenCalled()
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()
    expect(mocks.assignmentCreate).not.toHaveBeenCalled()
  })

  it.each([
    ["unknown assignment", [{ rowKey: "bad", assignmentId: "other", choreTemplateId: "kitchen", bookingGuestId: "guest-1" }], "ROSTER_ASSIGNMENT_INVALID"],
    ["inactive or cross-lodge template", [{ rowKey: "bad", choreTemplateId: "other", bookingGuestId: "guest-1" }], "ROSTER_TEMPLATE_INVALID"],
    ["ineligible guest", [{ rowKey: "bad", choreTemplateId: "kitchen", bookingGuestId: "other" }], "ROSTER_GUEST_INELIGIBLE"],
  ])("rejects %s before any mutation", async (_label, assignments, code) => {
    const result = await save(assignments)
    expect(result.init?.status).toBe(400)
    expect(result.body).toMatchObject({ code })
    expect(mocks.assignmentDeleteMany).not.toHaveBeenCalled()
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()
    expect(mocks.assignmentCreate).not.toHaveBeenCalled()
  })

  it("uses one authoritative eligibility query for lodge, date, operational status, consent and review state", async () => {
    await save([{ rowKey: "new", choreTemplateId: "kitchen", bookingGuestId: "guest-1" }])
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: expect.any(Array) },
        checkIn: { lte: DATE },
        checkOut: { gt: DATE },
        lodgeId: "lodge-1",
        NOT: { requiresAdminReview: true, adminReviewStatus: "PENDING" },
        guests: { some: expect.objectContaining({
          OR: [{ consentStatus: null }, { consentStatus: "CONFIRMED" }],
        }) },
      }),
    }))
  })

  it("groups by booking and applies D-R2 known-DOB then unknown-name order without exposing DOB", async () => {
    const stayEnd = new Date("2026-08-11T00:00:00.000Z")
    const guest = (id: string, firstName: string, lastName: string, dateOfBirth: Date | null) => ({
      id,
      bookingId: "booking-1",
      firstName,
      lastName,
      ageTier: "ADULT",
      stayStart: DATE,
      stayEnd,
      nights: [{ stayDate: DATE }],
      member: { ageTier: "ADULT", dateOfBirth },
    })
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "booking-1",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        checkIn: DATE,
        checkOut: stayEnd,
        member: { firstName: "Aroha", lastName: "Bell" },
        guests: [
          guest("unknown-z", "Zoe", "Bell", null),
          guest("young", "Mika", "Bell", new Date("2012-01-01T00:00:00.000Z")),
          guest("unknown-a", "Alex", "Bell", null),
          guest("old", "Aroha", "Bell", new Date("1975-01-01T00:00:00.000Z")),
        ],
      },
      eligibleBooking("booking-2", "other", "Taylor"),
    ])

    const result = await getAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      regenerate: false,
      lodgeId: "lodge-1",
    })
    const guests = (result.body as { guests: Array<Record<string, unknown>> }).guests
    expect(guests.map((entry) => entry.id)).toEqual([
      "old",
      "young",
      "unknown-a",
      "unknown-z",
      "other",
    ])
    expect(guests.slice(0, 4).map((entry) => entry.bookingGroupLabel)).toEqual([
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
    ])
    expect(guests.every((entry) => !("dateOfBirth" in entry))).toBe(true)
  })
})
