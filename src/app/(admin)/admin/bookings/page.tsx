import Link from "next/link";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { formatCents } from "@/lib/utils";
import { BookingFilters } from "@/components/admin/booking-filters";
import { BookingsPagination } from "@/components/admin/bookings-pagination";
import { AdminBookingCalendar } from "@/components/admin-booking-calendar";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { SortHeader } from "@/components/admin/sort-header";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusChip } from "@/components/ui/status-chip";
import { MiniChip } from "@/components/ui/mini-chip";
import { type ChipTone } from "@/lib/chip-tones";
import { EmptyState } from "@/components/ui/empty-state";
import {
  adminBookingsQuerySchema,
  buildAdminBookingsWhere,
  getDefaultAdminBookingSortDir,
  listAdminBookings,
  type AdminBookingRow,
  type BookingSortBy,
  type SortDir,
} from "@/lib/admin-bookings-service";
import { formatMemberPhone } from "@/lib/admin-member-detail-helpers";
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path";
import {
  listMemberGuestConsentExceptions,
  loadMemberGuestConsentQueueCounts,
} from "@/lib/member-guest-consent-exceptions";
import { formatConsentShortDate } from "@/lib/member-guest-consent-card";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { lodgeOrderBy } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { formatNZDate } from "@/lib/nzst-date";
import { formatBookingReference } from "@/lib/booking-reference";
import {
  AlertTriangle,
  CalendarX2,
  CircleDollarSign,
  CreditCard,
  Eye,
  Landmark,
  MinusCircle,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export function formatAdminBookingGuestCount(totalGuests: number, nonMemberGuests: number) {
  return `${totalGuests} (${nonMemberGuests} non-member${nonMemberGuests === 1 ? "" : "s"})`;
}

// Whole lodge nights between two date-only check-in/out values. Both are stored
// as midnight instants, so the raw millisecond span divides to exact nights —
// this is a display-only derivation and never touches the query/money math.
function nightsBetween(checkIn: Date, checkOut: Date) {
  return Math.max(
    0,
    Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000),
  );
}

// The inline non-status signals (payment source, review, deleted) render through
// the shared `MiniChip`, which draws its tone -> class map from
// `@/lib/chip-tones` — the single source shared with StatusChip and the other
// admin tables. Meaning is carried by icon + label, never colour alone.

function paymentChip(source: AdminBookingRow["operational"]["paymentSource"]): {
  tone: ChipTone;
  icon: LucideIcon;
  label: string;
} {
  switch (source) {
    case "STRIPE":
      return { tone: "info", icon: CreditCard, label: "Stripe" };
    case "INTERNET_BANKING":
      return { tone: "cat6", icon: Landmark, label: "Internet Banking" };
    case "NONE":
    default:
      return { tone: "neutral", icon: MinusCircle, label: "No payment" };
  }
}

/**
 * How much of the booking's money has actually arrived (#2350).
 *
 * A booking modified upwards after it was paid keeps its PAID lifecycle status —
 * correctly, the stay is confirmed — while the extra sits uncollected on the
 * payment row. Before this the list showed nothing at all, so the outstanding
 * amount was invisible everywhere. The booking status chip beside this one is
 * deliberately left alone; this reports SETTLEMENT, not lifecycle.
 *
 * Returns null whenever settlement and lifecycle agree — including the fully
 * settled case. A booking whose money has all arrived already carries a "Paid"
 * status chip in the column beside this one, and a second identical chip on
 * every paid row is the exact noise this function exists to avoid; the only
 * thing worth saying here is the disagreement.
 */
function paymentSettlementChip(booking: AdminBookingRow): {
  tone: ChipTone;
  icon: LucideIcon;
  label: string;
} | null {
  if (booking.operational.outstandingAdditionalCents > 0) {
    return { tone: "warning", icon: CircleDollarSign, label: "Partly paid" };
  }
  return null;
}

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    from?: string;
    to?: string;
    updatedFrom?: string;
    updatedTo?: string;
    checkInFrom?: string;
    checkInTo?: string;
    checkOutFrom?: string;
    checkOutTo?: string;
    search?: string;
    upcoming?: string;
    sort?: string;
    sortBy?: string;
    sortDir?: string;
    month?: string;
    deleted?: string;
    paymentSource?: string;
    xeroState?: string;
    bedState?: string;
    changeState?: string;
    consentState?: string;
    lodgeId?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const parsedQuery = adminBookingsQuerySchema.safeParse(params);
  const query = parsedQuery.success ? parsedQuery.data : adminBookingsQuerySchema.parse({});
  const session = await auth();
  const canEditBookings = session?.user
    ? hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
    : false;
  const effectiveModules = await loadEffectiveModuleFlags();
  const showBedAllocation = effectiveModules.bedAllocation;
  // Lodge filter and column appear only once a second active lodge exists
  // (ADR-002 presentation rule).
  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    orderBy: lodgeOrderBy(),
    select: { id: true, name: true },
  });
  const showLodge = activeLodges.length > 1;
  const { bookings, total, page, totalPages, sortBy, sortDir } =
    await listAdminBookings(query, {
      bedAllocationEnabled: showBedAllocation,
    });

  // #2307 (owner decision MG2-M-3 as ticked): the member-guest consent queues
  // are a FILTER on this list, not a new page. Each chip's number is the
  // number of rows clicking it reveals — bookings for "waiting" (the filtered
  // table lists bookings), stuck guest rows for "attention" (that chip swaps
  // in the per-guest exception table). The chips stay visible while the module
  // is off if anything is still stuck, because those rows need a human either
  // way.
  //
  // The waiting count is taken INSIDE the filters this URL already applies,
  // because clicking the chip narrows those filters rather than replacing
  // them. The consent chips are stripped out of the scope first: a waiting
  // count taken while the attention chip was open would only count bookings
  // that were both waiting AND stuck.
  const consentQueues = await loadMemberGuestConsentQueueCounts(prisma, {
    waitingScope: buildAdminBookingsWhere({ ...query, consentState: "all" }),
  });
  const showConsentChips =
    effectiveModules.memberGuests ||
    consentQueues.waitingBookings > 0 ||
    consentQueues.attentionGuests > 0;
  const consentState = query.consentState;
  const consentExceptions =
    consentState === "attention" ? await listMemberGuestConsentExceptions() : [];
  // #2576: the Booking Officer's durable queue belongs in the bookings
  // permission area, not only on the support dashboard.
  const [hostingCoverageIncidentCount, hostingCoverageIncidents] =
    await Promise.all([
      prisma.hostingCoverageIncident.count({
        where: {
          resolvedAt: null,
          ...(query.lodgeId ? { lodgeId: query.lodgeId } : {}),
        },
      }),
      prisma.hostingCoverageIncident.findMany({
        where: {
          resolvedAt: null,
          ...(query.lodgeId ? { lodgeId: query.lodgeId } : {}),
        },
        orderBy: [{ openedAt: "asc" }, { id: "asc" }],
        take: 50,
        select: {
          id: true,
          bookingId: true,
          cause: true,
          evidence: true,
          openedAt: true,
          booking: {
            select: {
              checkIn: true,
              checkOut: true,
              member: { select: { firstName: true, lastName: true } },
              lodge: { select: { name: true } },
            },
          },
        },
      }),
    ]);

  function visibleSearchParams() {
    const currentSearchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value && (showBedAllocation || key !== "bedState")) {
        currentSearchParams.set(key, value);
      }
    }

    return currentSearchParams;
  }
  const currentSearchParams = visibleSearchParams();
  const currentBookingsPath = buildPathWithSearch("/admin/bookings", currentSearchParams);

  function withPage(nextParams: URLSearchParams, targetPage: number) {
    nextParams.delete("page");
    if (targetPage > 1) nextParams.set("page", String(targetPage));
    const queryString = nextParams.toString();
    return queryString ? `/admin/bookings?${queryString}` : "/admin/bookings";
  }

  function sortHref(column: BookingSortBy) {
    const nextParams = visibleSearchParams();

    const nextDir: SortDir = sortBy === column
      ? sortDir === "asc" ? "desc" : "asc"
      : getDefaultAdminBookingSortDir(column);
    nextParams.delete("sort");
    nextParams.set("sortBy", column);
    nextParams.set("sortDir", nextDir);

    // Sorting reorders the same result set, so it keeps the current page
    // (#1738). Normalise to the clamped page from the service so a stale
    // out-of-range `page` in the URL cannot ride along.
    return withPage(nextParams, page);
  }

  function pageHref(targetPage: number) {
    return withPage(visibleSearchParams(), targetPage);
  }

  // Toggle a consent chip: clicking the active chip clears it, and any change
  // of queue resets to page 1 (a different result set).
  function consentChipHref(target: "waiting" | "attention") {
    const nextParams = visibleSearchParams();
    nextParams.delete("consentState");
    if (consentState !== target) nextParams.set("consentState", target);
    return withPage(nextParams, 1);
  }

  function consentChipClass(active: boolean) {
    return active
      ? "inline-flex items-center rounded-full border border-primary bg-primary px-3 py-1 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      : "inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-sm text-muted-foreground hover:border-primary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  }

  // One sortable header wired to the URL-driven sort links this page has always
  // built. `align="right"` keeps the numeric Total header aligned with its cell.
  function BookingSortHeader({
    column,
    children,
    align,
  }: {
    column: BookingSortBy;
    children: ReactNode;
    align?: "left" | "right";
  }) {
    return (
      <SortHeader
        active={sortBy === column}
        direction={sortDir}
        href={sortHref(column)}
        align={align}
      >
        {children}
      </SortHeader>
    );
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="All Bookings"
        actions={
          canEditBookings ? (
            <Link href="/admin/book" className="app-button-brand">
              + Create Booking
            </Link>
          ) : (
            <ViewOnlyActionButton canEdit={false}>+ Create Booking</ViewOnlyActionButton>
          )
        }
      />

      {hostingCoverageIncidentCount > 0 ? (
        <section
          id="hosting-coverage-incidents"
          aria-labelledby="hosting-coverage-incidents-title"
          className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-4"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 text-warning" />
            <div>
              <h2 id="hosting-coverage-incidents-title" className="font-semibold">
                Adult member cover needs attention · {hostingCoverageIncidentCount}
              </h2>
              <p className="text-sm text-muted-foreground">
                These confirmed bookings lost required adult member cover. Correct
                the party or dates, restore qualifying cover, approve a valid
                exception, or cancel the affected booking. Nothing is cancelled
                automatically.
              </p>
            </div>
          </div>
          <div className="divide-y divide-border rounded-md border border-border bg-card">
            {hostingCoverageIncidents.map((incident) => {
              const evidence = incident.evidence as {
                requirements?: { uncoveredNonMemberGuestNights?: unknown };
              } | null;
              const uncovered =
                typeof evidence?.requirements?.uncoveredNonMemberGuestNights ===
                "number"
                  ? evidence.requirements.uncoveredNonMemberGuestNights
                  : null;
              return (
                <div
                  key={incident.id}
                  className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {formatBookingReference(incident.bookingId)} ·{" "}
                      {incident.booking.member.firstName}{" "}
                      {incident.booking.member.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {incident.booking.lodge?.name ?? "Lodge"} ·{" "}
                      {formatNZDate(incident.booking.checkIn)}–
                      {formatNZDate(incident.booking.checkOut)}
                      {uncovered === null
                        ? ""
                        : ` · ${uncovered} uncovered guest-night${uncovered === 1 ? "" : "s"}`}
                      {incident.cause === "OFFICER_OVERRIDE"
                        ? " · officer override"
                        : " · qualification changed"}
                    </p>
                  </div>
                  <Link
                    href={buildHrefWithReturnTo(
                      `/bookings/${incident.bookingId}`,
                      `${currentBookingsPath}#hosting-coverage-incidents`,
                    )}
                    className="app-button-secondary shrink-0"
                  >
                    Review booking
                  </Link>
                </div>
              );
            })}
          </div>
          {hostingCoverageIncidentCount > hostingCoverageIncidents.length ? (
            <p className="text-xs text-muted-foreground">
              Showing the oldest {hostingCoverageIncidents.length}; resolve these
              to reveal the remaining incidents.
            </p>
          ) : null}
        </section>
      ) : null}

      <BookingFilters
        showBedAllocation={showBedAllocation}
        lodgeOptions={activeLodges}
      />

      <AdminBookingCalendar />

      {showConsentChips ? (
        // `role="group"` because an aria-label on a bare <div> is not exposed
        // to assistive technology at all — the div has no role to hang a name
        // on, so the label is simply dropped. Same pattern as the "Rows per
        // page" group in admin-pagination.tsx.
        //
        // Each chip that is ON says so IN ITS ACCESSIBLE NAME, not only through
        // colour and `aria-current`: a screen-reader user should hear which
        // queue they are looking at without having to infer it, and the repo
        // already writes exactly this ("N rows per page, current"). The label
        // still starts with the visible text, so a voice-control user can say
        // what they can see.
        <div role="group" aria-label="Consent queues" className="flex flex-wrap gap-2">
          <Link
            href={consentChipHref("waiting")}
            aria-current={consentState === "waiting" ? "true" : undefined}
            aria-label={
              consentState === "waiting"
                ? `Waiting for consent · ${consentQueues.waitingBookings}, current`
                : undefined
            }
            className={consentChipClass(consentState === "waiting")}
          >
            Waiting for consent · {consentQueues.waitingBookings}
          </Link>
          <Link
            href={consentChipHref("attention")}
            aria-current={consentState === "attention" ? "true" : undefined}
            aria-label={
              consentState === "attention"
                ? `Consent needs attention · ${consentQueues.attentionGuests}, current`
                : undefined
            }
            className={consentChipClass(consentState === "attention")}
          >
            Consent needs attention · {consentQueues.attentionGuests}
          </Link>
        </div>
      ) : null}

      {consentState === "attention" ? (
        consentExceptions.length === 0 ? (
          <div className="rounded-lg border border-border bg-card">
            <EmptyState
              icon={CalendarX2}
              title="Nothing needs attention"
              description="Every declined or lapsed consent request has been resolved automatically. Rows land here only when a guest could not be removed without a human."
            />
          </div>
        ) : (
          <AdminDataTable
            stickyFirstColumn
            aria-label="Consent needs attention"
            className="min-w-[56rem]"
            toolbar={
              <p>
                {consentExceptions.length} stuck consent row
                {consentExceptions.length === 1 ? "" : "s"} — each one needs a
                human; nothing here resolves on its own.
              </p>
            }
          >
            <TableHeader>
              <TableRow>
                <TableHead>Booking</TableHead>
                <TableHead>Guest</TableHead>
                <TableHead>Why it is stuck</TableHead>
                <TableHead>What fixes it</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {consentExceptions.map((row) => (
                // The guest row's own id: two guests on one booking may share a
                // name (a family with a repeated first name, or two "J Smith"),
                // and a duplicate key makes React reuse the wrong row.
                <TableRow key={row.guestId}>
                  <TableCell>
                    <Link
                      href={buildHrefWithReturnTo(`/bookings/${row.bookingId}`, currentBookingsPath)}
                      className="group inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block text-sm font-medium text-foreground group-hover:text-primary group-hover:underline">
                        {row.lodgeName ? `${row.lodgeName} · ` : ""}
                        {formatNZDate(row.checkIn)} – {formatNZDate(row.checkOut)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {row.bookerName}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm font-medium">
                      {row.guestFirstName} {row.guestLastName}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {row.status === "DECLINED"
                        ? `Said no${row.statusAt ? `, ${formatConsentShortDate(row.statusAt)}` : ""}`
                        : `Lapsed${row.statusAt ? ` ${formatConsentShortDate(row.statusAt)}` : ""}, never answered`}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">{row.why}</TableCell>
                  <TableCell className="text-sm">{row.fix}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </AdminDataTable>
        )
      ) : bookings.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            icon={CalendarX2}
            title="No bookings found"
            description="No bookings match your current filters. Try clearing or adjusting them."
          />
        </div>
      ) : (
        <div className="space-y-2">
          <AdminDataTable
            stickyFirstColumn
            aria-label="Bookings"
            className="min-w-[56rem]"
            toolbar={
              <p>
                Showing {bookings.length} of {total} bookings found
                {totalPages > 1 ? ` (page ${page} of ${totalPages})` : ""}
              </p>
            }
          >
            <TableHeader>
              <TableRow>
                <BookingSortHeader column="member">Member</BookingSortHeader>
                {showLodge ? <TableHead>Lodge</TableHead> : null}
                <BookingSortHeader column="lastUpdated">Last Updated</BookingSortHeader>
                <BookingSortHeader column="checkIn">Stay</BookingSortHeader>
                <BookingSortHeader column="guests">Guests</BookingSortHeader>
                <BookingSortHeader column="total" align="right">Total</BookingSortHeader>
                <BookingSortHeader column="status">Status</BookingSortHeader>
                <TableHead>Payment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bookings.map((booking) => {
                const nonMemberGuestCount = booking.guests.filter((guest) => !guest.isMember).length;
                const payment = paymentChip(booking.operational.paymentSource);
                const settlement = paymentSettlementChip(booking);
                const outstandingAdditionalCents =
                  booking.operational.outstandingAdditionalCents;
                const nights = nightsBetween(booking.checkIn, booking.checkOut);

                return (
                  <TableRow key={booking.id}>
                    <TableCell>
                      <Link
                        href={buildHrefWithReturnTo(`/admin/members/${booking.member.id}`, currentBookingsPath)}
                        className="group inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="block text-sm font-medium text-foreground group-hover:text-primary group-hover:underline">
                          {booking.member.firstName} {booking.member.lastName}
                        </span>
                        <span className="block text-xs text-muted-foreground">{booking.member.email}</span>
                      </Link>
                      {formatMemberPhone(booking.member) ? (
                        <span className="block text-xs text-muted-foreground">
                          {formatMemberPhone(booking.member)}
                        </span>
                      ) : null}
                    </TableCell>
                    {showLodge ? (
                      <TableCell className="text-sm">
                        {booking.lodge?.name ?? "—"}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-sm">{formatNZDate(booking.updatedAt)}</TableCell>
                    <TableCell className="text-sm">
                      <span className="block">{formatNZDate(booking.checkIn)}</span>
                      <span className="block text-xs text-muted-foreground">to {formatNZDate(booking.checkOut)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {nights} night{nights === 1 ? "" : "s"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatAdminBookingGuestCount(booking.guests.length, nonMemberGuestCount)}
                    </TableCell>
                    <TableCell className="text-right text-sm font-medium tabular-nums">
                      {formatCents(booking.finalPriceCents)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={buildHrefWithReturnTo(`/bookings/${booking.id}`, currentBookingsPath)}
                          className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <StatusChip kind="booking" value={booking.status} />
                        </Link>
                        {booking.requiresAdminReview ? (
                          <Link
                            href={`/admin/booking-requests?tab=approvals&bookingId=${booking.id}&status=ALL`}
                            className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <MiniChip tone="warning" icon={Eye}>Review</MiniChip>
                          </Link>
                        ) : null}
                        {booking.deletedAt ? (
                          <MiniChip tone="danger" icon={Trash2}>Deleted</MiniChip>
                        ) : null}
                        {booking.overlapsExclusiveHold ? (
                          <MiniChip tone="warning" icon={CalendarX2}>
                            Overlaps exclusive hold
                          </MiniChip>
                        ) : null}
                      </div>
                      {booking.requiresAdminReview && booking.adminReviewReason ? (
                        <p className="mt-1 text-xs text-warning">{booking.adminReviewReason}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <MiniChip tone={payment.tone} icon={payment.icon}>
                          {payment.label}
                        </MiniChip>
                        {settlement ? (
                          <MiniChip tone={settlement.tone} icon={settlement.icon}>
                            {settlement.label}
                          </MiniChip>
                        ) : null}
                        {outstandingAdditionalCents > 0 ? (
                          <MiniChip tone="warning" icon={AlertTriangle}>
                            {formatCents(outstandingAdditionalCents)} due
                          </MiniChip>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </AdminDataTable>
          <BookingsPagination
            page={page}
            totalPages={totalPages}
            total={total}
            hrefForPage={pageHref}
          />
        </div>
      )}
    </div>
  );
}
