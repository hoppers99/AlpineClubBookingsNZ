import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requireActiveSessionUser } from "@/lib/session-guards"
import { prisma } from "@/lib/prisma"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges"
import { hasAdminAccess } from "@/lib/access-roles"
import { getOperationalRosterGuestsForDate } from "@/lib/roster-eligibility"

// The two-step date contract every sibling `[date]` roster route keeps (see
// `/api/admin/roster/[date]`): a value that is not a calendar day at all is
// "Invalid date format", and a value that passed the shape check but still does
// not parse is "Invalid date". The second branch is unreachable while
// `parseDateOnly` re-runs `isDateOnlyString` internally — it is kept, and
// pinned by test, so swapping in a looser parser cannot silently let a bad
// value through to a query. Note what the shape check refuses: `2026-02-30` is
// rejected rather than rolled forward to 2 March, so a mistyped night can never
// print another night's roster under the heading that was asked for.
function parseRosterDate(dateStr: string) {
  if (!isDateOnlyString(dateStr)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 },
      ),
    }
  }
  const date = parseDateOnly(dateStr)
  if (isNaN(date.getTime())) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Invalid date" }, { status: 400 }),
    }
  }
  return { ok: true as const, date }
}

// Lodge scope for the printed sheet, mirroring `/api/admin/roster/[date]`: an
// explicit `?lodgeId=` must name an active lodge; omitted falls back to the
// club's default lodge, so a single-lodge club sees no change.
async function resolveRosterLodgeId(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("lodgeId") ?? undefined
  const lodgeId = await resolveOptionalActiveLodgeId(prisma, requested)
  if (!lodgeId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      ),
    }
  }
  return { ok: true as const, lodgeId }
}

/**
 * GET /api/chores/roster/[date]/print
 * Returns roster data formatted for the print view
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const session = await auth()
  if (!session?.user || !hasAdminAccess(session.user)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { date: dateStr } = await params
  // #2478. A roster night is a CALENDAR DAY: it is stored in `@db.Date`
  // columns, which Prisma reads and writes as UTC midnight, and it is matched
  // here by equality. `new Date(dateStr + "T00:00:00")` parsed it at the
  // SERVER's wall-clock midnight instead, so under the production
  // `TZ=Pacific/Auckland` pin the filter resolved to (D-1)T12:00Z and matched
  // no assignment row.
  //
  // Recorded so the next reader does not go looking for a broken screen:
  // NOTHING IN THE APP CALLS THIS ENDPOINT. The admin "Print Roster" button
  // goes to `/api/admin/roster/[date]`, which has always parsed the night
  // correctly. The fix is preventative — it stops a future print page
  // inheriting a wrong-day query — not a repair of breakage an operator saw.
  // `parseDateOnly` is the one calendar-day contract the sibling roster routes
  // already share.
  const parsedDate = parseRosterDate(dateStr)
  if (!parsedDate.ok) return parsedDate.response
  const date = parsedDate.date

  // Lodge scoping (docs/multi-lodge/lodge-scoping-contract.md): "Roster/chore
  // generation for a date runs per lodge and only sees that lodge's templates
  // and staying guests." Without this the sheet for one lodge would list the
  // other lodge's chores and count its guests in the headcount.
  const lodge = await resolveRosterLodgeId(req)
  if (!lodge.ok) return lodge.response

  const assignments = await prisma.choreAssignment.findMany({
    where: {
      date,
      // ChoreAssignment carries no lodgeId of its own; its lodge is the
      // template's, the same join `/api/lodge/roster/[date]/frequency-info`
      // uses.
      choreTemplate: lodgeNullTolerantScope(lodge.lodgeId),
      booking: lodgeNullTolerantScope(lodge.lodgeId),
    },
    include: {
      choreTemplate: true,
      bookingGuest: true,
    },
    orderBy: { choreTemplate: { sortOrder: "asc" } },
  })

  // ONE CHOKE POINT FOR THE HEADCOUNT (#2631). The sheet's "N guests" sits
  // beside the chore table, so it has to be the roster's own population, not a
  // second query that can disagree with it. `getOperationalRosterGuestsForDate`
  // is the same selector the admin roster, the hut-leader wizard and chore
  // generation read: the OPERATIONAL DAY (so a guest whose last night was last
  // night is counted — they are here this morning and they are on the sheet),
  // with the explicit night rows loaded so a sparse stay's gap day is not
  // counted, owner decision D-12's consent predicate applied, soft-deleted
  // bookings excluded, and a booking blocked by a pending admin review left out
  // exactly as the roster leaves it out. Only the count is used here; none of
  // the selector's other fields (including its booking-owner label) is returned.
  const guestCount = (
    await getOperationalRosterGuestsForDate(date, lodge.lodgeId)
  ).length

  // Group by chore
  const byChore = new Map<string, {
    sortOrder: number
    name: string
    description: string | null
    guests: string[]
  }>()

  for (const a of assignments) {
    if (!byChore.has(a.choreTemplateId)) {
      byChore.set(a.choreTemplateId, {
        sortOrder: a.choreTemplate.sortOrder,
        name: a.choreTemplate.name,
        description: a.choreTemplate.description,
        guests: [],
      })
    }
    if (a.bookingGuest) {
      byChore.get(a.choreTemplateId)!.guests.push(
        `${a.bookingGuest.firstName} ${a.bookingGuest.lastName}`
      )
    }
  }

  const chores = [...byChore.values()].sort((a, b) => a.sortOrder - b.sortOrder)

  return NextResponse.json({
    date: dateStr,
    guestCount,
    chores,
  })
}
