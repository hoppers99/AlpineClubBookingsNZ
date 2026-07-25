import { z } from "zod";
import type { CalendarEvent, CalendarEventSeries } from "@prisma/client";
import {
  CALENDAR_RECURRENCE_FREQUENCIES,
  MAX_OCCURRENCES,
  type RecurrenceEndMode,
} from "@/lib/calendar-recurrence";
import { resolveMirotalkMeetingToken } from "@/lib/mirotalk-token";
import { getAppBaseUrl } from "@/lib/app-url";

/** MiroTalk dev instance used when the app itself is on a loopback host. */
const LOCAL_MIROTALK_FALLBACK = "http://localhost:3010";

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

// Emit the "loopback fallback in production" warning at most once per process so
// a misconfigured prod deploy is diagnosable without spamming every click.
let warnedLoopbackFallback = false;

/**
 * Return the localhost MiroTalk dev instance, warning ONCE when this happens in
 * production — a prod deploy that resolves meeting links to `localhost:3010`
 * means `MIROTALK_URL` was not set and the app origin looks like a loopback
 * host, so every join link points at the clicker's own machine.
 */
function loopbackFallback(): string {
  if (process.env.NODE_ENV === "production" && !warnedLoopbackFallback) {
    warnedLoopbackFallback = true;
    console.warn(
      "[calendar] MIROTALK_URL is unset and the app origin resolves to a " +
        "loopback host; meeting join links point at the localhost dev instance " +
        "(http://localhost:3010). Set MIROTALK_URL in the production environment.",
    );
  }
  return LOCAL_MIROTALK_FALLBACK;
}

/**
 * Default MiroTalk base URL when `MIROTALK_URL` is not set: derive
 * `https://meet.<app-domain>` from the
 * app's OWN origin (`NEXTAUTH_URL`, via getAppBaseUrl). This makes a production
 * deploy that forgot to set `MIROTALK_URL` point at a real, same-domain host the
 * operator controls (e.g. `https://meet.example.org`) — a visible, diagnosable
 * failure if that subdomain is not up — instead of the old
 * `http://localhost:3010`, which silently resolved to the *clicker's own
 * machine* on every prod deploy.
 *
 * A leading `www.` is dropped; any other extra subdomain is kept (an app at
 * `bookings.example.org` derives `meet.bookings.example.org`), so operators on a
 * non-www subdomain should set `MIROTALK_URL` explicitly. When the app host is a
 * loopback (local dev), fall back to the localhost MiroTalk dev instance (with a
 * one-time production warning — see {@link loopbackFallback}).
 */
function defaultMirotalkBaseUrl(): string {
  try {
    const { hostname } = new URL(getAppBaseUrl());
    if (isLoopbackHost(hostname)) return loopbackFallback();
    return `https://meet.${hostname.replace(/^www\./i, "")}`;
  } catch {
    return loopbackFallback();
  }
}

/**
 * Base URL of the self-hosted MiroTalk instance used for meeting events.
 *
 * Resolved at call time, and used ONLY server-side (a join URL is minted per
 * click on the join endpoint, never during list serialization or in a client
 * bundle), so it is a RUNTIME setting: set `MIROTALK_URL` in the app's
 * environment and restart — no rebuild needed. Only the runtime `MIROTALK_URL`
 * is honoured; the old build-time `NEXT_PUBLIC_MIROTALK_URL` path is gone
 * (NEXT_PUBLIC_* values are inlined at BUILD time and never reached this
 * server-only code).
 *
 * A value with no scheme is assumed to be https, so `meet.example.org` becomes
 * `https://meet.example.org/...` rather than a broken relative link. When unset,
 * the base is derived from the app's own domain — see {@link defaultMirotalkBaseUrl}.
 */
function resolveMirotalkBaseUrl(): string {
  const raw = process.env.MIROTALK_URL?.trim();
  if (!raw) return defaultMirotalkBaseUrl();
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * Build a MiroTalk join URL for a stored room slug. When JWT access is
 * configured (MIRO_JWT_KEY + host credentials), a freshly-signed, short-lived
 * access token authenticates committee members as host so the meeting starts
 * with no login prompt. The token is minted per request — the signing key and
 * host password never reach the browser (see src/lib/mirotalk-token.ts).
 *
 * IMPORTANT: MiroTalk only reads the token on its QUERY-form route
 * (`/join?room=…&token=…`). Its path-form route (`/join/<room>`) is a different
 * handler that ignores the token and shows the "waiting for host" page, so a
 * token URL must use the query form. Without a token we keep the friendlier
 * path form (the standard shareable MiroTalk link).
 */
export function buildMeetingJoinUrl(room: string): string {
  const base = resolveMirotalkBaseUrl().replace(/\/+$/, "");
  const token = resolveMirotalkMeetingToken();
  if (token) {
    return `${base}/join?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`;
  }
  return `${base}/join/${encodeURIComponent(room)}`;
}

/**
 * Request body for creating / updating a calendar event. Dates arrive as ISO
 * strings the client builds from the date + time (or all-day) inputs; they are
 * range-validated in {@link resolveCalendarEventDates}, not here, so a bad
 * end-before-start pairing yields a specific message rather than a generic zod
 * failure.
 */
/** Recurrence rule sent with a create / series-edit request; null = one-off. */
export const recurrenceInputSchema = z.object({
  frequency: z.enum(CALENDAR_RECURRENCE_FREQUENCIES),
  interval: z.number().int().min(1).max(52),
  endMode: z.enum(["never", "until", "count"]),
  until: z.string().nullish(),
  count: z.number().int().min(1).max(MAX_OCCURRENCES).nullish(),
});

export const calendarEventInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  location: z.string().trim().max(200).nullish(),
  details: z.string().trim().max(5000).nullish(),
  allDay: z.boolean(),
  startsAt: z.string().min(1, "Start date is required"),
  endsAt: z.string().nullish(),
  isMeeting: z.boolean(),
  recurrence: recurrenceInputSchema.nullish(),
});

export type CalendarEventInput = z.infer<typeof calendarEventInputSchema>;

/** Which occurrences a series-event edit or delete applies to. */
export const calendarEditScopeSchema = z.enum(["single", "series"]);
export type CalendarEditScope = z.infer<typeof calendarEditScopeSchema>;

/**
 * Parse and range-check the ISO date strings. Returns concrete Dates, or an
 * `error` message for the 400. An all-day event keeps `endsAt` null; a timed
 * event may carry an end that must not precede the start.
 */
export function resolveCalendarEventDates(
  input: Pick<CalendarEventInput, "startsAt" | "endsAt" | "allDay">,
): { startsAt: Date; endsAt: Date | null } | { error: string } {
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return { error: "Invalid start date/time" };
  }

  if (input.allDay || !input.endsAt) {
    return { startsAt, endsAt: null };
  }

  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(endsAt.getTime())) {
    return { error: "Invalid end date/time" };
  }
  if (endsAt.getTime() < startsAt.getTime()) {
    return { error: "End time must be on or after the start time" };
  }
  return { startsAt, endsAt };
}

/** The recurrence rule of the event's series, in the client's input shape. */
export type RecurrenceSummaryDTO = {
  frequency: (typeof CALENDAR_RECURRENCE_FREQUENCIES)[number];
  interval: number;
  endMode: RecurrenceEndMode;
  until: string | null;
  count: number | null;
};

export function recurrenceSummaryFromSeries(
  series: CalendarEventSeries,
): RecurrenceSummaryDTO {
  const endMode: RecurrenceEndMode = series.until
    ? "until"
    : series.count != null
      ? "count"
      : "never";
  return {
    frequency: series.frequency,
    interval: series.interval,
    endMode,
    until: series.until ? series.until.toISOString() : null,
    count: series.count,
  };
}

/**
 * Wire shape a calendar event takes on the client.
 *
 * NOTE: there is deliberately NO meeting URL / token field. The MiroTalk join
 * token embeds shared host credentials (presenter=true), so it is minted per
 * click on `POST /api/calendar/events/[id]/join` — gated to calendar managers
 * and audited — never served to every member in the list response. The client
 * shows a "Join" affordance off `isMeeting` alone and fetches the URL on click.
 */
export type CalendarEventDTO = {
  id: string;
  title: string;
  location: string | null;
  details: string | null;
  allDay: boolean;
  startsAt: string;
  endsAt: string | null;
  isMeeting: boolean;
  seriesId: string | null;
  detachedFromSeries: boolean;
  /** The series rule when this event recurs (null for a one-off). */
  recurrence: RecurrenceSummaryDTO | null;
};

/**
 * Serialise a stored event for the API. Builds NO meeting join URL: the host
 * token is never placed in a list/serialise payload (see {@link CalendarEventDTO}
 * and {@link buildMeetingJoinUrl}).
 */
export function serializeCalendarEvent(
  event: CalendarEvent & { series?: CalendarEventSeries | null },
): CalendarEventDTO {
  return {
    id: event.id,
    title: event.title,
    location: event.location,
    details: event.details,
    allDay: event.allDay,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
    isMeeting: event.isMeeting,
    seriesId: event.seriesId,
    detachedFromSeries: event.detachedFromSeries,
    recurrence: event.series
      ? recurrenceSummaryFromSeries(event.series)
      : null,
  };
}
