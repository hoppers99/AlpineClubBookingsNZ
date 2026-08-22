import { NextResponse } from "next/server";
import { z } from "zod";

import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { normaliseClubTimeZone } from "@/lib/club-time-zone";
import {
  CLUB_TIME_SETTINGS_ID,
  resolveClubTimeZoneWithSource,
  type ClubTimeZoneSource,
} from "@/lib/club-time-zone-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The club-timezone maintenance API (CT-1, #2989; epic #2988).
 *
 * FULL ADMIN, ON BOTH VERBS, AND NOT BY AREA LEVEL. Both handlers pass
 * `requireAdmin({ permission: false })`, which is the guard's "only a full
 * administrator" shape (see `RequireAdminOptions` in `src/lib/session-guards.ts`).
 * The two other shapes are both wrong here and both look right at a glance: an
 * OMITTED `permission` infers the requirement from the path, which for these
 * prefixes is `support` — so a support editor would be admitted — and
 * `"any-admin"` is a deliberate widening to every admitted administrator. Both
 * `/admin/club-time` and `/api/admin/club-time-zone` are registered under the
 * `support` area in `ROUTE_AREA_PREFIXES` so the route-map drift guard resolves
 * them to a concrete area instead of the `overview` catch-all and the sidebar's
 * matrix check can answer; that AREA decides who can reach the surface at all,
 * and the `permission: false` here is what actually enforces Full Admin.
 *
 * THE CONFIRMATION IS ENFORCED HERE, not only in the panel. A checkbox in a
 * browser is a courtesy to the operator; this route is where "the admin was told
 * what this does" becomes a precondition of the write, because the panel is not
 * the only thing that can call it.
 *
 * THE TRANSACTION TOUCHES EXACTLY TWO TABLES — `ClubTimeSettings` and
 * `AuditLog` — and that is a contract rather than an implementation detail.
 * Changing the club timezone rewrites NO historical instant and NO date-only
 * value: a lodge night keeps the calendar date it already has, and a stored
 * timestamp keeps the instant it already records. What changes is how instants
 * are DISPLAYED from here on and when club-local scheduled work fires. A write
 * here that touched a booking, a payment or a member's dates would be that
 * promise broken, so the route's test enumerates the delegates and fails if any
 * other one is called.
 *
 * NO ADVISORY LOCK, deliberately. A single-row configuration upsert composes no
 * capacity claim, no settlement money and no lifecycle transition, which is what
 * `docs/CONCURRENCY_AND_LOCKING.md` reserves the lock tiers for. Two
 * administrators saving at once resolve last-write-wins, and each one's audit row
 * records what that one actually did.
 */

/**
 * Name fields ONLY. The maintenance panel says WHO last changed the timezone, so
 * it needs a display name and nothing else — selecting the member's email (or
 * the whole row) would put a contact address into a configuration payload that
 * has no use for one.
 */
const MEMBER_NAME_SELECT = { firstName: true, lastName: true } as const;

/** The projection every read and write of the singleton uses. */
const CLUB_TIME_SETTINGS_SELECT = {
  timeZone: true,
  updatedByMemberId: true,
  updatedAt: true,
} as const;

type PersistedRow = {
  timeZone: string;
  updatedByMemberId: string | null;
  updatedAt: Date;
};

/**
 * What both verbs return. Deliberately NOT the 418-zone selector list: the
 * option list is a browser-side list of CHOICES and has no business travelling
 * on the payload that says what the club's timezone actually is.
 */
type ClubTimeZoneState = {
  timeZone: string;
  source: ClubTimeZoneSource;
  updatedAt: string | null;
  updatedByName: string | null;
};

/**
 * The display name of the member who last saved, or `null`. Defensive on
 * purpose: the column is a plain string with no foreign key (the house shape for
 * every settings singleton), so the member may since have been merged or
 * deleted. A missing member, a blank name or an unreachable database all mean
 * "we cannot name them", never a failed read of the timezone.
 */
async function readChangedByName(
  memberId: string | null,
): Promise<string | null> {
  if (!memberId) return null;
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: MEMBER_NAME_SELECT,
    });
    if (!member) return null;
    return `${member.firstName} ${member.lastName}`.trim() || null;
  } catch {
    return null;
  }
}

async function stateFromRow(row: PersistedRow): Promise<ClubTimeZoneState> {
  return {
    timeZone: row.timeZone,
    // A row exists, so the persisted value IS the answer — the environment seed
    // is only consulted when nothing is persisted.
    source: "persisted",
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: await readChangedByName(row.updatedByMemberId),
  };
}

export async function GET() {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;

  const resolved = await resolveClubTimeZoneWithSource();
  return NextResponse.json({
    state: {
      timeZone: resolved.timeZone,
      source: resolved.source,
      updatedAt: resolved.persisted?.updatedAt.toISOString() ?? null,
      updatedByName: await readChangedByName(
        resolved.persisted?.updatedByMemberId ?? null,
      ),
    } satisfies ClubTimeZoneState,
  });
}

/**
 * `confirmed` is OPTIONAL in the schema and required by the check below, so that
 * an absent flag and an explicit `false` get the same plain-English refusal
 * rather than one of them falling out as a generic "invalid body".
 */
const changeSchema = z
  .object({
    timeZone: z.string().max(200),
    confirmed: z.boolean().optional(),
  })
  .strict();

const INVALID_ZONE_MESSAGE =
  "Enter a named IANA time zone such as Pacific/Auckland. Abbreviations " +
  "(NZT, EST) and fixed offsets (+12:00, Etc/GMT-12) are refused: they name " +
  "no place, so they carry no daylight-saving rules.";

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;
  const actingMemberId = guard.session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = changeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (parsed.data.confirmed !== true) {
    return NextResponse.json(
      {
        error:
          "Changing the club time zone has to be confirmed before it is saved.",
      },
      { status: 400 },
    );
  }

  const timeZone = normaliseClubTimeZone(parsed.data.timeZone);
  if (!timeZone) {
    return NextResponse.json({ error: INVALID_ZONE_MESSAGE }, { status: 400 });
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const before = await tx.clubTimeSettings.findUnique({
      where: { id: CLUB_TIME_SETTINGS_ID },
      select: CLUB_TIME_SETTINGS_SELECT,
    });

    /*
      DIRTY GATING (docs/ARCHITECTURE.md -> "Admin/member layer"). Re-saving the
      value already stored writes nothing at all: no row, no `updatedAt` bump and
      no audit row. An audit trail that records changes which never happened is
      worse than no trail, because the next person reading it cannot tell the
      difference. Re-read INSIDE the transaction rather than before it so a
      concurrent save cannot land between the check and the write.
    */
    if (before && before.timeZone === timeZone) {
      return { changed: false as const, row: before };
    }

    const row = await tx.clubTimeSettings.upsert({
      where: { id: CLUB_TIME_SETTINGS_ID },
      update: { timeZone, updatedByMemberId: actingMemberId },
      create: {
        id: CLUB_TIME_SETTINGS_ID,
        timeZone,
        updatedByMemberId: actingMemberId,
      },
      select: CLUB_TIME_SETTINGS_SELECT,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "CLUB_TIME_ZONE_UPDATED",
        actor: { memberId: actingMemberId },
        entity: { type: "ClubTimeSettings", id: CLUB_TIME_SETTINGS_ID },
        // Installation configuration, exactly like CLUB_IDENTITY_SETTINGS_UPDATED.
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Club time zone updated",
        /*
          THE BEFORE AND AFTER ZONE, AND NOTHING ELSE (#2989 requirement 6: "do
          not audit unrelated settings payload"). `before: null` means nothing
          was persisted yet — the club was running on the environment seed or on
          the documented default. No request echo, no settings blob, nothing
          about the acting member beyond the actor id the row already carries.
        */
        metadata: { before: before?.timeZone ?? null, after: timeZone },
        request: getAuditRequestContext(request),
      }),
    );

    return { changed: true as const, row };
  });

  return NextResponse.json({
    changed: outcome.changed,
    state: await stateFromRow(outcome.row),
  });
}
