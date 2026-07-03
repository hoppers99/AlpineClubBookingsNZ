import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isActionTokenFormat } from "@/lib/action-tokens";
import { ApiError } from "@/lib/api-error";
import { parseJsonRequestBody } from "@/lib/api-json";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import {
  applySchoolAttendeeConfirmation,
  SchoolAttendeeConfirmationError,
} from "@/lib/school-attendee-confirmation";

const confirmSchema = z.object({
  token: z.string().min(1).max(200),
  guestUpdates: z
    .array(
      z.object({
        guestId: z.string().min(1).max(60),
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
      }),
    )
    .max(200)
    .optional(),
  confirm: z.boolean().optional(),
});

/**
 * Public school attendee confirmation endpoint (#1101). Token-authenticated
 * (SHA-256 hash lookup, rotated on every email); applies identity-only guest
 * name updates through the shared quoted-booking machinery and records the
 * school's explicit confirmation. Rate limited like the other token flows.
 */
export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(
    rateLimiters.bookingRequestToken,
    request,
  );
  if (rateLimited) return rateLimited;

  const parsedBody = await parseJsonRequestBody(request);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = confirmSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!isActionTokenFormat(parsed.data.token)) {
    return NextResponse.json(
      { error: "This attendee confirmation link is invalid." },
      { status: 404 },
    );
  }

  try {
    const result = await applySchoolAttendeeConfirmation({
      token: parsed.data.token,
      guestUpdates: parsed.data.guestUpdates,
      confirm: parsed.data.confirm,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SchoolAttendeeConfirmationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
