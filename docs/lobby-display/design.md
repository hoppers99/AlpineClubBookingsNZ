# Lobby TV Display — Design Specification

**Status:** Implemented on the `feature/lobby-display` integration branch
(epic hoppers99#25, all tasks merged). Not yet proposed upstream as code;
heads-up posted in
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
//
// Keys the built-in furniture reads (LTV-015/016; any other key is
// available to templates via {{config:<key>}}):
//   wifi-name / wifi-code  — the footer Wi-Fi item
//   contact-email          — the footer email item
//   footer-note            — right-aligned accent note in the footer
//   whole-lodge-note       — note pill on the blockout panel + welcome tile
//   checkin-note           — message line on the welcome panel
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

New auth surface, deliberately weaker than every existing tier. Decided in
[ADR-001](decisions/ADR-001-device-pairing-auth-model.md) (threat model,
token lifetime, cookie vs header, rate limiting) and implemented in issue
#27.

> **Route namespace (ADR-001 §1):** display routes live at `/display` and
> `/api/display/*` (admin management under `/api/admin/display/*`) — NOT
> under `/lodge` as first sketched, because the kiosk flag gates the whole
> `/lodge` prefix space and the display module must work without the kiosk.

Pairing flow (stateless start / admin bind / device claim — ADR-001 §2):

1. Admin creates a device record (name + lodge) in the admin UI.
2. TV browser visits `/display` unauthenticated → the page requests a
   pairing code from the public pairing endpoint, which returns the code
   inside an HMAC-signed httpOnly cookie blob and persists nothing.
3. Admin enters/confirms the code against the device record in the admin UI
   (this persists the code + 15-minute expiry onto the device row).
4. The TV's claim poll matches its signed blob to the bound code and
   receives a long-lived display token (httpOnly cookie), stored hashed on
   the device record; the pairing fields clear (single-use). The page
   reloads into display mode.

Auth behaviour:

- The display token authenticates **only**: the display page shell, the
  display-state API, and a lightweight heartbeat (updates `lastSeenAt`).
  Everything else treats it as anonymous. In practice the state poll
  doubles as the heartbeat (LTV-013): every successful device-token fetch
  stamps `lastSeenAt`, so admins see a live "last seen" without a separate
  call; admin previews never stamp it.
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

`GET /api/display/state` (display-token auth; window parameters
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

> **Implemented** (fork issue #29, [ADR-002](decisions/ADR-002-template-model-and-storage.md)):
> `src/lib/lodge-display/template-registry.ts` (definition schema, validator,
> built-in starter templates, DB-override resolution) and
> `src/lib/lodge-display/conditions.ts` (named condition engine). Definitions
> are data-only and revalidated on every load; unknown module/condition names
> are rejected with the offending detail.

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
playlists are out of v1 scope. A region may alternatively declare
`layout: "stack"` (LTV-015) to render all eligible panels at once — the
everyday board's side rail uses this for its chores/instructions/notice
cards, matching the approved mockup's rail treatment.

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
  region configuration. The page opens with setup instructions showing the
  concrete display URL (copyable), and each device offers a **Preview**
  link opening `/display?previewDevice=<id>` in a new tab.
- **Templates**: list built-ins, copy-to-custom, edit region config,
  **preview** rendered with live data (reusing the read-only preview
  pattern from the kiosk per-account preview, upstream PR #1721), plus a
  **full-screen preview** link (`/display?preview=1&templateKey=<key>`).
- **Admin preview** (implemented in LTV-013): the display state API honours
  `?previewDevice=<id>` / `?preview=1[&templateKey=…]` only for a
  signed-in full admin; anyone else gets the normal 401 and the page shows
  a sign-in prompt instead of a pairing code. Previews render through the
  same privacy-reduced serialiser, never stamp `lastSeenAt`, and show no
  warning banner (the preview is the real screen). A genuine device token
  always takes precedence over preview parameters.
- **Lodge config glob**: JSON editor with key validation and token-help
  copy derived from the catalogue.
- Name-granularity setting surfaced alongside (home per the privacy task).

## 9. Display page

- Full-screen route (`/display` — ADR-001 §1 namespace), 16:9-first, container-query sizing
  (`cqh`/`cqw`), dedicated display stylesheet sharing club branding tokens
  (palette/logo) with the site. Rendering lessons from the mockups apply
  (content-height grid rows so dense bars never clip; charset; text sized
  for distance).
- States: unpaired (pairing code), active (bound template), stale-data
  indicator, revoked/expired (back to pairing), module-flag-off (404 via
  proxy).

## 10. Privacy and security

### Settled naming rules (issue #28, 2026-07-11)

Enforced solely in `src/lib/lodge-display-state.ts` — the serialiser is the
single choke point; no template or module can display more than it serves.

**Granularity levels** (`DisplayNameGranularity`; per-lodge override on
`Lodge.displayNameGranularity`, null = club default
`FIRST_NAME_SURNAME_INITIAL` — full names included as a level per the
upstream owner's input on discussion #964):

| Level | Adult guest renders as |
|---|---|
| `FULL_NAME` | Jane Smith |
| `FIRST_NAME_SURNAME_INITIAL` (default) | Jane S |
| `FIRST_NAME_ONLY` | Jane |
| `COUNTS_ONLY` | (no names — counts and labels only) |

**Rules that override the level (in order):**

1. **Organisations** (organiser member `ageTier = NOT_APPLICABLE` — schools,
   clubs): the booking shows the organisation's full name at every level;
   its guests are never listed individually.
2. **Whole-lodge blockout**: a booking that is the sole occupant on every
   NIGHT it covers in the window AND is a genuine group (organisation, or
   ≥ `WHOLE_LODGE_MIN_GUESTS` = 8 guests) collapses to its label only. Sole
   occupancy is measured on nights, not departure-day visibility (LTV-016):
   a group leaving in the morning keeps its blockout even when the next
   booking arrives that evening. The guest-count heuristic is a v1
   constant — review-flagged on epic #25.
3. **Bookings containing minors** (`ageTier` INFANT/CHILD/YOUTH): collapse
   to a family label — "«Surname» family" at the two fuller levels,
   "Family of N" at `FIRST_NAME_ONLY` — and guests are never listed.
   **Minors are never individually named at any level**, including as chore
   assignees (a minor's chore shows the booking's family/group label
   instead).
4. Otherwise (adults-only booking): the organiser labels the booking and
   guests list at the configured level.

**Window**: default 3 days, hard cap 7 (`DISPLAY_WINDOW_MAX_DAYS`) — an
out-of-range request clamps rather than erroring.

**Payload deltas from the §5 sketch** (implemented shape in
`lodge-display-state.ts`): booking rows are split per (booking, room) with
an opaque `key` (never the real booking id); per-guest `arriving` dropped
(derivable from dates client-side); `rules` is an array of instruction
documents; a `notice` field ships null until LTV-011.

### Standing security properties

- Display token: hashed at rest, revocable, least-privilege route
  allow-list, rate-limited pairing, no PII in URLs (ADR-001).
- The serialiser never selects monetary, payment, contact, or member-id
  fields; the phone-number opt-in feature (#37) would extend it under an
  explicit two-sided consent model, not here.
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
