import { afterEach, describe, it, expect, vi } from "vitest";
import type { CalendarEvent } from "@prisma/client";

// buildMeetingJoinUrl now pulls in the server-only mirotalk-token module; the
// client-boundary guard must be neutralised for this Node test.
vi.mock("server-only", () => ({}));
import {
  buildMeetingJoinUrl,
  resolveCalendarEventDates,
  serializeCalendarEvent,
} from "@/lib/calendar-events";

describe("resolveCalendarEventDates", () => {
  it("returns start with null end for an all-day event", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-08-01T05:00:00.000Z",
      allDay: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.endsAt).toBeNull();
    expect(result.startsAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps a valid timed end", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T19:00:00.000Z",
      endsAt: "2026-08-01T20:30:00.000Z",
      allDay: false,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.endsAt?.toISOString()).toBe("2026-08-01T20:30:00.000Z");
  });

  it("rejects an end before the start", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T20:00:00.000Z",
      endsAt: "2026-08-01T19:00:00.000Z",
      allDay: false,
    });
    expect("error" in result).toBe(true);
  });

  it("rejects an unparseable start", () => {
    const result = resolveCalendarEventDates({
      startsAt: "not-a-date",
      endsAt: null,
      allDay: false,
    });
    expect("error" in result).toBe(true);
  });
});

describe("buildMeetingJoinUrl", () => {
  const savedRuntime = process.env.MIROTALK_URL;
  const savedPublic = process.env.NEXT_PUBLIC_MIROTALK_URL;
  const savedNextAuth = process.env.NEXTAUTH_URL;

  afterEach(() => {
    if (savedRuntime === undefined) delete process.env.MIROTALK_URL;
    else process.env.MIROTALK_URL = savedRuntime;
    if (savedPublic === undefined) delete process.env.NEXT_PUBLIC_MIROTALK_URL;
    else process.env.NEXT_PUBLIC_MIROTALK_URL = savedPublic;
    if (savedNextAuth === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = savedNextAuth;
    // Token vars are never set in the base cases; clear any a test set so the
    // no-token assertions elsewhere in this file are not affected.
    delete process.env.MIRO_JWT_KEY;
    delete process.env.MIRO_MEETING_USERNAME;
    delete process.env.MIRO_MEETING_PASSWORD;
    delete process.env.MIRO_MEETING_PRESENTER;
  });

  it("falls back to the localhost MiroTalk dev instance for a loopback app host", () => {
    delete process.env.MIROTALK_URL;
    delete process.env.NEXT_PUBLIC_MIROTALK_URL;
    delete process.env.NEXTAUTH_URL; // getAppBaseUrl → http://localhost:3000
    expect(buildMeetingJoinUrl("room-abc")).toBe(
      "http://localhost:3010/join/room-abc",
    );
  });

  it("derives https://meet.<app-domain> from NEXTAUTH_URL when MIROTALK_URL is unset", () => {
    delete process.env.MIROTALK_URL;
    delete process.env.NEXT_PUBLIC_MIROTALK_URL;
    process.env.NEXTAUTH_URL = "https://lwtc.org.nz";
    expect(buildMeetingJoinUrl("room-abc")).toBe(
      "https://meet.lwtc.org.nz/join/room-abc",
    );
  });

  it("drops a leading www. when deriving the meet.<domain> default", () => {
    delete process.env.MIROTALK_URL;
    delete process.env.NEXT_PUBLIC_MIROTALK_URL;
    process.env.NEXTAUTH_URL = "https://www.lwtc.org.nz";
    expect(buildMeetingJoinUrl("xyz")).toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });

  it("uses the runtime MIROTALK_URL (server-only, no rebuild)", () => {
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    expect(buildMeetingJoinUrl("xyz")).toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });

  it("uses the query-form URL with room + token when JWT access is configured", () => {
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    process.env.MIRO_JWT_KEY = "shared-key";
    process.env.MIRO_MEETING_USERNAME = "lwtc";
    process.env.MIRO_MEETING_PASSWORD = "pw";
    const url = buildMeetingJoinUrl("xyz");
    // MiroTalk only honours the token on /join?room=…&token=… (not /join/<room>).
    expect(url.startsWith("https://meet.lwtc.org.nz/join?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("room")).toBe("xyz");
    // A three-part JWT in token=.
    expect((params.get("token") ?? "").split(".")).toHaveLength(3);
  });

  it("assumes https for a bare host with no scheme", () => {
    process.env.MIROTALK_URL = "meet.lwtc.org.nz";
    expect(buildMeetingJoinUrl("xyz")).toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });

  it("ignores the dead build-time NEXT_PUBLIC_MIROTALK_URL (only MIROTALK_URL is honoured)", () => {
    // NEXT_PUBLIC_MIROTALK_URL is inlined at build time and never reached this
    // server-only path; with MIROTALK_URL unset we fall back to the app-domain
    // default, NOT the baked value.
    delete process.env.MIROTALK_URL;
    process.env.NEXT_PUBLIC_MIROTALK_URL = "https://baked.example.org";
    process.env.NEXTAUTH_URL = "https://lwtc.org.nz";
    expect(buildMeetingJoinUrl("xyz")).toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });
});

describe("serializeCalendarEvent", () => {
  const base: CalendarEvent = {
    id: "evt-1",
    title: "Committee meeting",
    location: "Clubrooms",
    details: null,
    allDay: false,
    startsAt: new Date("2026-08-01T19:00:00.000Z"),
    endsAt: new Date("2026-08-01T20:00:00.000Z"),
    isMeeting: false,
    meetingRoom: null,
    createdById: "member-1",
    idempotencyKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    seriesId: null,
    detachedFromSeries: false,
  };

  it("never emits a meeting URL/token field — even for a meeting with a room", () => {
    // SECURITY: the host token must not be served in the list payload. The DTO
    // carries no join URL at all; the token is minted per click on the gated,
    // audited join endpoint instead.
    const dto = serializeCalendarEvent({
      ...base,
      isMeeting: true,
      meetingRoom: "xyz",
    });
    expect(dto).not.toHaveProperty("meetingUrl");
    // No value anywhere in the DTO leaks the room slug or a join link.
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain("xyz");
    expect(serialised).not.toContain("/join");
  });

  it("still exposes isMeeting so the client can render a Join affordance", () => {
    expect(serializeCalendarEvent({ ...base, isMeeting: true }).isMeeting).toBe(
      true,
    );
    expect(serializeCalendarEvent(base).isMeeting).toBe(false);
  });

  it("summarises the recurrence rule for a series event", () => {
    const dto = serializeCalendarEvent({
      ...base,
      seriesId: "series-1",
      series: {
        id: "series-1",
        frequency: "WEEKLY",
        interval: 1,
        until: null,
        count: 5,
        createdById: "member-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(dto.recurrence).toEqual({
      frequency: "WEEKLY",
      interval: 1,
      endMode: "count",
      until: null,
      count: 5,
    });
  });

  it("has a null recurrence for a one-off event", () => {
    expect(serializeCalendarEvent(base).recurrence).toBeNull();
  });
});
