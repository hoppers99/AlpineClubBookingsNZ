// Global test setup.
//
// The email layer (src/lib/email-delivery.ts) validates delivery configuration
// and refuses to build a transport — throwing "Email delivery is not
// configured" — when EMAIL_FROM or the SES credentials are absent. Unit tests
// mock nodemailer's transport, so no real mail is ever sent; these fake values
// exist only to satisfy that config gate, mirroring how CI supplies a fake
// STRIPE_SECRET_KEY value.
//
// EMAIL_FROM is set to SAFE_DEFAULT_CONFIG.supportEmail — the exact value
// email-sender.ts falls back to when EMAIL_FROM is unset (C6 #1985: the envelope
// sender is bootstrap-derived, never club.json) — so the rendered "from" address
// is byte-for-byte identical to the unset behaviour and no test that asserts the
// sender address changes. Set with ??= so any test that deliberately exercises a
// different/!ok config by assigning or deleting these keeps control.
import { afterAll, vi } from "vitest";
import { SAFE_DEFAULT_CONFIG } from "@/config/club";
import {
  installFrozenTestClock,
  restoreRealTestClock,
} from "@/lib/__tests__/helpers/clock";

// `server-only` is a Next.js guard that throws when a module is imported outside
// a Server Component. Server-side libraries (e.g. member-photo.ts) legitimately
// import it; in the Vitest node environment the guard has no meaning, so stub it
// globally. Without this, any test that transitively imports a server-only
// module fails to load. Applies to all test files via setupFiles.
vi.mock("server-only", () => ({}));

process.env.EMAIL_FROM ??= SAFE_DEFAULT_CONFIG.supportEmail;
process.env.AWS_SES_ACCESS_KEY_ID ??= "test-ses-access-key-id";
process.env.AWS_SES_SECRET_ACCESS_KEY ??= "test-ses-secret-access-key";

// Freeze "today" for every test file (#2481, absorbing #2443). Four times a
// calendar rollover turned `main` and every open PR red at once with nothing in
// any diff to blame (#2426, #2401, #2443, #2479), because fixed date fixtures
// sat under code reading the real wall clock. One fixed instant —
// 2026-07-01T00:00:00.000Z, midday NZ so UTC and NZ agree on the date — removes
// that whole class.
//
// Only `Date` is faked, so real timers still drive awaited promises. A suite
// that wants a different instant just pins its own: `sequence.hooks: "stack"`
// (declared in vitest.config.ts) runs these setup hooks first, so any per-file
// `vi.setSystemTime` overrides this one. A file that needs the REAL clock calls
// `optOutOfFrozenClock("<reason>")` at module top level and is then pinned by
// `src/lib/__tests__/frozen-test-clock.test.ts`.
//
// The canary workflow winds this forward via `TEST_CLOCK_OFFSET_DAYS` (integer
// days) or `TEST_CLOCK_ISO` (an absolute instant); both are documented in
// `src/lib/__tests__/helpers/clock.ts`.
//
// Installed HERE, in the setup file's module body, and deliberately NOT in a
// `beforeAll`: setup modules evaluate before the test file is imported, whereas
// a `beforeAll` runs only after every module in the file's graph has already
// been evaluated. Module-level date constants are real code —
// `src/components/admin-sidebar.tsx:123` builds its deep link from today's date
// at import time — and a hook-based freeze silently left those on the real
// clock.
installFrozenTestClock();

afterAll(() => {
  restoreRealTestClock();
});
