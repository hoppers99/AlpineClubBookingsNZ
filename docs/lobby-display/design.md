# Lobby TV Display — Design Specification

**Status:** Draft — fork feature in development on the `feature/lobby-display`
integration branch. Not yet proposed upstream as code; heads-up posted in
[upstream discussion #964](https://github.com/thatskiff33/AlpineClubBookingsNZ/discussions/964#discussioncomment-17602129).

This document expands the [feature brief](brief.md) into a technical design —
see [`README.md`](README.md) for the feature overview and design gallery, and
[`mockups/`](mockups/) for the design-exploration catalogue. Structural
decisions with real trade-offs get ADRs in `docs/lobby-display/decisions/`
(same pattern as `docs/finance-dashboard/decisions/`), authored with the
keystone tasks that implement them.

---

## 1. Overview and principles

A read-only, per-lodge lobby display: a paired TV/device renders an
admin-chosen template of lodge activity and arrival information, driven by
live booking data, safe to show in a public physical space.

Principles, in priority order:

1. **Entirely data-driven.** Everything on screen derives from data the
   system already holds (bookings, room assignments, chore rosters, lodge
   instructions, per-lodge config). No display-specific content to keep
   current beyond template choice and config values. The display introduces
   no second source of truth.
2. **Privacy enforced at the data layer.** The display-state API serialises
   names already reduced to the configured granularity. No template, module,
   or custom markup can display more than the API serves.
3. **Weakest-privilege auth surface.** A display token reaches only the
   display page and display-state API for its bound lodge — never kiosk,
   member, or admin routes. Read-only by construction.
4. **Lodge-scoped from day one.** All data resolution reuses the kiosk
   lodge-scoping machinery (`resolveKioskLodgeId` patterns, ambiguous
   bindings deny per the M5 precedent).
5. **Off by default.** Gated by a `ClubModuleSettings.lobbyDisplay` flag;
   clubs that do not enable it see no routes, UI, or tokens.

## 2. Displayable content (v1 targets)

Per lodge:

- **Bookings and room assignments** in all three occupancy modes:
  - bed allocation enabled → room-grouped views;
  - allocation disabled → by-booking views;
  - whole-lodge/group bookings → blockout view (booking/group name only).
- **Chore list / assignments** — the day's roster from existing chore data.
- **Lodge rules and arrival information** — club-authored content (lodge
  instructions), plus lodge-specific values via config tokens (wifi code,
  check-in reminders).
- **Skifield conditions** — later addition: reuse the existing
  `{{skifield-conditions}}` embed once widget data is configured for the
  relevant skifield. Not a v1 blocker.

## 3. Data model

> **Implemented** (fork issue #26, migration `20260711000100_add_lobby_display_schema`):
> `prisma/schema.prisma` is now the source of truth for these shapes. The
> sketch below is retained for rationale; the implemented schema differs only
> in detail — length caps on name/key/pairing-code columns, explicit
> `onDelete: Restrict` (lodge) / `SetNull` (template) referential actions,
> and indexes on `lodgeId`/`templateId`.

```prisma
model LodgeDisplayDevice {
  id            String    @id @default(cuid())
  lodgeId       String
  name          String                    // "Lobby TV", admin-assigned
  // Pairing lifecycle: created → pairing (code active) → paired → revoked
  pairingCode   String?                   // short-lived, single-use
  pairingCodeExpiresAt DateTime?
  tokenHash     String?   @unique         // hashed long-lived display token
  templateId    String?                   // bound DisplayTemplate (null = club default)
  regionConfig  Json?                     // per-device region/module configuration
  lastSeenAt    DateTime?
  revokedAt     DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  lodge         Lodge     @relation(...)
}

model DisplayTemplate {
  id          String   @id @default(cuid())
  key         String   @unique            // built-in key or custom slug
  name        String
  source      DisplayTemplateSource       // BUILT_IN_OVERRIDE | CUSTOM
  definition  Json                        // regions, default modules, options
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

// Per-lodge config glob (probably a field, not a model):
// Lodge.displayConfig Json?  — {"wifi-code": "...", "checkin-note": "..."}
```

Notes:

- Built-in templates ship as a **code registry** (like the token catalogue);
  `DisplayTemplate` rows exist only for admin overrides/custom templates —
  the `EmailTemplateOverride` pattern.
- Token storage follows `docs/TOKEN_HASHING.md` conventions (hash at rest).
- Migrations are additive; run `npm run db:check-drift` against a shadow DB.
- The name-granularity setting's home (club-wide default + per-lodge
  override) is decided in the privacy task — exact naming rules are an
  **open design question** (see §10).

## 4. Device pairing and display auth

New auth surface, deliberately weaker than every existing tier. ADR required
before implementation (threat model, token lifetime, cookie vs header).

Pairing flow:

1. Admin creates a device record (name + lodge) in the admin UI.
2. TV browser visits `/lodge/display` unauthenticated → the page shows a
   short pairing code (device generates/receives it from a public pairing
   endpoint; code is short-lived, single-use, rate-limited).
3. Admin enters/confirms the code against the device record in the admin UI.
4. The TV receives a long-lived display token (httpOnly cookie), stored
   hashed on the device record. The page reloads into display mode.

Auth behaviour:

- The display token authenticates **only**: the display page shell, the
  display-state API, and a lightweight heartbeat (updates `lastSeenAt`).
  Everything else treats it as anonymous.
- Tokens are revocable per device from the admin UI; a revoked device stops
  rendering lodge data within one refresh interval and returns to the
  pairing screen.
- Survives reboots/network blips (cookie persistence); re-pairing needed
  only on revocation or expiry.
- Ambiguous lodge binding is impossible by construction (deviceId → lodgeId
  is a direct FK), but lodge resolution still validates the lodge is active.
- The whole surface is gated by the `lobbyDisplay` module flag in the proxy
  layer (as kiosk routes are today): flag off → 404.

## 5. Display-state API (the data contract)

`GET /api/lodge/display/state` (display-token auth; window parameters
validated server-side against configured bounds).

One JSON payload per request covering the display window — every module is
a pure function of this payload:

```ts
interface DisplayState {
  lodge: { name: string };
  generatedAt: string;            // ISO instant, for stale detection
  window: { start: string; days: number };   // NZ date-only strings
  rooms: Array<{ id: string; name: string }> | null;  // null = allocation off
  bookings: Array<{
    id: string;                   // opaque, not the real booking id
    label: string;                // privacy-reduced booking/group label
    wholeLodge: boolean;
    roomId: string | null;
    guests: Array<{
      label: string;              // privacy-reduced name per granularity
      stayStart: string;          // date-only
      stayEnd: string;            // date-only (check-out)
      arriving: boolean;          // relative to each window day client-side
    }> | null;                    // null when counts-only granularity
    guestCount: number;
  }>;
  occupancy: Array<{ date: string; arriving: number; departing: number; staying: number }>;
  chores: Array<{ date: string; title: string; assigneeLabels: string[] }>;
  rules: { html: string } | null; // sanitised lodge-instructions content
  config: Record<string, string>; // per-lodge glob, values escaped
}
```

- **Privacy reduction happens here** (labels, counts-only mode, group
  labelling) — the serialiser is the single enforcement point and the
  primary unit-test surface for privacy rules.
- Data sourcing reuses the kiosk queries (`LODGE_VISIBLE_BOOKING_STATUSES`,
  stay-range helpers, `lodgeNullTolerantScope`) — no parallel query logic.
- Client polls on an interval (config, default ~60s); the page shows a
  stale indicator when `generatedAt` ages past a threshold and keeps the
  last good render on transient failures.

## 6. Template model

Two layers (settled in the brief):

- **Templates define structure**: a named set of regions plus the config
  options each region exposes. Provided templates ship in the code registry
  (the approved mockups become the starter set); technical operators can
  author custom templates, which still declare regions, so the admin
  configuration surface stays uniform.
- **Region configuration populates a template**: per region, admins place
  modules/tokens and set options. The device binding stores template +
  region config.

Rotation is **template-level and condition-aware**: a region may hold a
rotation of panels; each panel declares an eligibility condition evaluated
against the display-state payload. v1 conditions are a fixed named set
(recommendation: `always`, `whole-lodge-booking-in-window`,
`arrivals-today`, `no-guests`); ineligible panels are skipped so a screen
never rotates into a view that is wrong for the current data. Device-level
playlists are out of v1 scope.

Starter templates (from the approved mockups in the design exploration):

| Template | Main region content |
|---|---|
| Everyday board | `{{display-arrivals-board}}` bar board |
| Whole-lodge | `{{display-occupancy-grid}}` blockout, rotating with welcome panel |
| Singles house | `{{display-singles-board}}` by-booking rows |

## 7. Token catalogue and modules

Extends `src/lib/token-catalogue.ts` with a **`lodge-display` context** and
new embed modules (the `{{skifield-conditions}}` pattern):

- `{{display-arrivals-board:days=3}}` — arrivals/departures/staying bars.
- `{{display-occupancy-grid}}` — whole-lodge blockout grid.
- `{{display-welcome}}` — welcome panel.
- `{{display-singles-board}}` — by-booking Room | Guest rows.
- `{{display-chores-board}}` — the day's chore assignments.
- `{{display-lodge-rules}}` — lodge rules / arrival information.
- Text tokens: `{{lodge-name}}`, `{{display-date}}`, and **config tokens**
  `{{config:<key>}}` resolving from the lodge's config glob (reuses the
  existing `{{token:parameter}}` grammar; keys validated, values escaped,
  unresolved keys render a visible placeholder).

Module design rules: sensible zero-parameter defaults; parameters tune
behaviour; a small options-based styling set (row colouring rules, accent
side, corner radius) rather than free CSS.

## 8. Admin UI

Modelled on the kiosk account management surface (`/admin/lodge`):

- **Devices**: list per lodge (name, paired state, last seen), create,
  pair (code confirmation), revoke, per-device template assignment and
  region configuration.
- **Templates**: list built-ins, copy-to-custom, edit region config,
  **preview** rendered with live data (reusing the read-only preview
  pattern from the kiosk per-account preview, upstream PR #1721).
- **Lodge config glob**: JSON editor with key validation and token-help
  copy derived from the catalogue.
- Name-granularity setting surfaced alongside (home per the privacy task).

## 9. Display page

- Full-screen route (`/lodge/display`), 16:9-first, container-query sizing
  (`cqh`/`cqw`), dedicated display stylesheet sharing club branding tokens
  (palette/logo) with the site. Rendering lessons from the mockups apply
  (content-height grid rows so dense bars never clip; charset; text sized
  for distance).
- States: unpaired (pairing code), active (bound template), stale-data
  indicator, revoked/expired (back to pairing), module-flag-off (404 via
  proxy).

## 10. Privacy and security

- Public physical screen ⇒ treat shown names as published. Granularity
  levels, family/group labelling, and minors handling are **open design
  questions** to be settled in the privacy task before the serialiser is
  built. Firm intent: minors are not individually named on a public screen;
  enforcement lives in the API serialiser.
- Display token: hashed at rest, revocable, least-privilege route
  allow-list, rate-limited pairing, no PII in URLs.
- The display surface performs no writes except its own pairing/heartbeat
  bookkeeping.
- Security-sensitive tasks (pairing/auth, serialiser) carry `risk:high`
  review depth and ADRs regardless of the low blast-radius of merging to
  the integration branch.

## 11. Testing strategy

- **Unit**: privacy serialiser (every granularity × booking shape ×
  minors/group case), pairing state machine, condition evaluation, config
  token resolution/escaping, template registry.
- **Route tests**: display-state auth matrix (no token / valid / revoked /
  wrong lodge / flag off), pairing endpoints (expiry, single-use,
  rate-limit), admin device routes.
- **E2E (Playwright)**: pair a device → render each starter template →
  revoke → back to pairing; multi-lodge fixture proves lodge scoping (a
  Lodge A device never renders Lodge B data). Add rows to
  `docs/END_TO_END_TEST_MATRIX.md`.
- Full gate (`lint`, `db:generate`, `typecheck`, `test`, `build`) green per
  child PR into the integration branch; drift check on schema changes.

## 12. Delivery model

- All work on the fork. Child issues (fork tracker) → child PRs targeting
  `feature/lobby-display` → merged there as they pass the gate.
- Dependency order: schema → pairing/auth → display-state API → template
  engine/modules → display page → admin UI → privacy serialiser rules →
  docs/E2E hardening. (Exact task list lives in the fork epic.)
- One upstream PR at the end (`thatskiff33 main` ← the completed feature),
  raised only after end-to-end validation and **express owner approval on
  the fork side**; upstream review per upstream conventions.
