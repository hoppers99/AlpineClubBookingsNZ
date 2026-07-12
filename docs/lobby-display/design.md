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

> **Superseded by v2** (LTV-024, migration `20260712100000_display_authoring_v2`):
> ADR-003's authoring model landed. The data-only `DisplayTemplate`
> region/panel model and its `DisplayTemplateSource` enum are **removed**, and
> `LodgeDisplayDevice.regionConfig` is dropped (per-display content now lives on
> the Template). The new entities in `prisma/schema.prisma` are **`DisplayLayout`**
> (`key`, `name`, `description?`, `bodyHtml`, `defaultCss`, `areas` Json) and a
> fresh **`DisplayTemplate`** (`key`, `name`, `layoutId` FK → DisplayLayout
> [Restrict], `slotContent` Json, `cssOverrides`, `footerHtml`). The device keeps
> `templateId` (FK → the new DisplayTemplate, SetNull) and `templateKey`
> (interim resolution against the code built-ins until LTV-027/033). The Lodge
> display columns (`displayConfig`, `displayNameGranularity`, `displayNotice`)
> are unchanged. The sketch below is the retired MVP shape, kept for history.

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
against the display-state payload. Conditions are a closed, namespaced
`namespace:name` registry (ADR-003 §3, LTV-025): the default `always`, the
`occupancy:*` states (`whole-lodge-today`, `whole-lodge-in-window`,
`empty-today`, `arrivals-today`, `departures-today`), the `content:*` states
(`notice`, `instructions`), and the `<module>:*` capability/data conditions
(`bed-allocation:enabled`, `chores:enabled`, `chores:today`) generated from the
module registry. Ineligible panels are skipped so a screen
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

**Module metadata (LTV-026).** Each module declares its contract in a
client-safe registry (`src/lib/lodge-display/module-registry.ts`, ADR-003 §1):
`label`, `description`, its club-module `dependencies` and a `dependencyMode`
(`degrades` — renders a reduced form, e.g. per-booking rows when bed allocation
is off; or `hides` — renders nothing, as `chores-board` does when the Chores
flag is off), the stable `cssHooks` class names admins target, the conditions it
`contributes`, and its `embedToken`. This one registry drives the Conditions/
modules reference screen (LTV-034), the render-boundary dependency fallback (a
`hides` module is replaced with an empty `data-module-disabled` placeholder so
the rail keeps its shape), and the CSS-hook stability contract (a test fails CI
if a declared hook is renamed).

**Token + content resolution (LTV-028, ADR-003 §4).** Two kinds of token resolve
inside admin-authored content, both scoped strictly to the display's OWN token
set — never the site-wide `token-catalogue.ts`, so a wall can never surface a
site token beyond the privacy-reduced payload:

- **Value tokens** (`{{config:<key>}}`, `{{lodge-name}}`, `{{display-date}}`)
  resolve **server-side** in `buildLayoutRender` (`layout-render.ts`) against the
  bound lodge's `DisplayState`, running AFTER the CMS sanitiser over every
  authored html surface (body, slot html, `defaultContent`, footer). Each
  injected value is **HTML-escaped** (and its braces neutralised) so a config
  value renders as inert text even inside html — an `<img onerror=…>` value
  appears literally, never as an element, and cannot form a second token. An
  unset key keeps the visible `⟨config:key?⟩` marker. The shared grammar lives in
  `display-text.ts` (`resolveDisplayText` for React text nodes,
  `resolveDisplayHtml` for html surfaces).
- **Module embed tokens** (`{{module:<name>}}`) mount the real React module
  **client-side**: `splitHtmlOnModuleTokens` (`layout-registry.ts`) splits the
  sanitised html and `SlotRender`/the footer render mount components between
  fragments (unknown name → neutral placeholder). The bare name only — options
  belong to `{module, options}` slot content; `validateHtmlModuleEmbeds` rejects
  unknown names and any `{{module:name(...)}}` argument form at authoring time.
- **Token scope is the security line:** any `{{…}}` outside the display token
  set (including a real site token such as `{{club-name}}`) is left VERBATIM as
  literal text.

**Authored CSS handling + theme tokens (LTV-029, ADR-003 §4).** A Layout's
`defaultCss` and a Template's `cssOverrides` are admin-authored but reach an
unattended wall, so `layout-render.ts` hardens both server-side via the
client-safe `css-tokens.ts` before they ship in the payload:

- **Sanitisation** (`sanitiseDisplayCss`) — targeted lexical neutralisation, not
  a full parser: strips `</style` and any stray `<`, strips `@import`/`@charset`,
  neutralises the legacy `expression(`/`-moz-binding` vectors, and — the ADR's
  named residual — removes any `url()` whose target is not a relative/root path
  or a `data:` URI (external http(s), protocol-relative `//host`, and other
  schemes are replaced with a `/* blocked: external url */` marker). Each field
  is capped at 20k chars (`/* truncated */` marker). Benign CSS passes through
  unchanged.
- **Scoping** (`scopeDisplayCss`) — every top-level selector is prefixed with
  `.display-authored-root ` so authored CSS only styles the editable body/footer.
  `@media`/`@supports` have their inner selectors prefixed; `@keyframes` passes
  through unchanged (names are global); other at-rules are stripped. The fixed
  header (clock/brand) renders OUTSIDE `.display-authored-root` (a
  `display:contents` wrapper) so a template can never restyle the chrome; the
  authored footer renders inside it, the built-in fallback footer outside.
- **Theme tokens** — the club theme's `buildClubThemeCss` output ships as a
  non-authored, unscoped `themeCss` injected BEFORE the authored CSS (order:
  theme → layout → overrides), so `:root { --brand-* }` cascades and a Template
  can `var(--brand-gold)`/`var(--display-accent)` to match the website by
  default, without any change to the site CSS structure. The stable token set
  (the `--display-*` palette + the `--brand-*`/font tokens) is exported for the
  authoring UI and reference screen via `listDisplayCssTokens()`.

## 8. Admin UI

> **Navigation (LTV-031, ADR-003).** The display admin lives under one **Lobby
> Display** sidebar parent instead of scattered Lodge Operations entries. The
> group holds **Devices** (`/admin/display`, heading "Display Devices"),
> **Layouts** (`/admin/display/layouts`), **Templates**
> (`/admin/display/templates`), and **Display Settings**
> (`/admin/display/settings`). The settings card was renamed off the
> `/admin/display/templates` path so LTV-033's Template authoring could claim
> it: LTV-031 parked the path on a temporary redirect to
> `/admin/display/settings`, and **LTV-033 replaced that redirect with the real
> Template manager** (the redirect page and its test are gone). The
> **Reference** entry (`/admin/display/reference`) — the combined
> Modules/Conditions/CSS-tokens reference — landed with LTV-034 (#80), and
> LTV-035/#81 relocates the Display Settings
> content into the lodge configuration hub. Terminology follows ADR-003:
> **Layout / Template / Module / Conditions**.

> **Layouts (LTV-032, #78).** The **Layouts** entry
> (`/admin/display/layouts`) is live: a Layout CRUD list (name, key,
> description, template-usage count, edit/delete — delete is blocked with a
> clear 409 while any Template still uses the layout) plus an authoring editor.
> The editor exposes the **Body HTML** and **Default CSS** as plain monospace
> `<textarea>`s — layout HTML is *structural* (the `{{area:key}}` skeleton), so
> the website page-content rich editor is deliberately not used here; slot
> *content* gets the rich editor per Template (LTV-033). **Areas** are edited as
> rows: key, description, kind (static / conditional / rotator), a **condition**
> chosen only from the closed registry dropdown (`listDisplayConditions()`, with
> the description as hover help), rotator `rotateSeconds` + child slots, and an
> optional default-content HTML box. The CSS field surfaces the theme tokens
> from `listDisplayCssTokens()` as copy-ready `var(--…)` hints. Saving runs the
> shared `validateLayoutForSave` contract **server-side** in the API route
> (`/api/admin/display/layouts` GET/POST, `/api/admin/display/layouts/[id]`
> GET/PUT/DELETE — all `requireAdmin`, audit-logged, admin boundary): structural
> errors block the save and render inline (path + message); CSS-sanitiser
> warnings ride along on an accepted save as amber notices. The layout **key is
> immutable** after creation so Template bindings and seeds stay stable.
> Preview-before-save arrives with the sandboxed/template preview (#82/#79); the
> editor draft is structured so `{ bodyHtml, defaultCss, areas }` can be handed
> to that future preview call.

> **Templates (LTV-033, #79).** The **Templates** entry
> (`/admin/display/templates`) is live: a Template CRUD list (name, key, bound
> layout, device-usage count, edit/delete — delete is blocked with a clear 409
> while any device is still bound) plus an authoring editor. A Template is built
> on a **Layout**, chosen from a dropdown (the layouts API) and **locked after
> creation** — changing the layout would orphan slot content authored against the
> original areas, and the key is likewise immutable once devices bind to it. The
> editor **generates one content box per declared slot** of the bound layout:
> static/conditional areas key off the area, a rotator gets one box per child
> (labelled `area / child`), each seeded from the layout's `defaultContent` when
> present. Each slot box toggles between **HTML** (a monospace `<textarea>`;
> `{{config:key}}`, `{{lodge-name}}`, `{{display-date}}`, `{{module:name}}` tokens
> resolve at serve time) and **Module** (a dropdown from `listDisplayModules()`
> with descriptions, plus a small scalar key/value options editor). A **CSS
> overrides** box (layered after the layout default; the theme tokens from
> `listDisplayCssTokens()` surface as copy-ready `var(--…)` hints) and a **Footer
> HTML** box complete the form. Saving runs the shared `validateTemplateForSave`
> contract **server-side** (`/api/admin/display/templates` GET/POST,
> `/api/admin/display/templates/[id]` GET/PUT/DELETE — all `requireAdmin`,
> audit-logged, admin boundary): structural errors block the save and render
> inline (path + message); CSS-sanitiser warnings ride along on an accepted save
> as amber notices. A muted hint reminds the author that templates render against
> whichever lodge their display is bound to, so lodge-specific values come from
> `{{config:…}}` tokens (ADR-003 §1).
>
> *Slot-content editor deviation.* ADR-003 §1 calls for the **website
> page-content rich editor** on each slot. That editor (`page-content-panel.tsx`)
> is a heavyweight surface coupled to `EditablePageRecord` CRUD, uploads, and page
> save endpoints — not a reusable rich-text field — so v1 ships a plain monospace
> `<textarea>` for slot HTML instead, matching the Layouts editor. Safety is
> unchanged: all authored HTML is sanitised at serve time (LTV-029) and validated
> by the save contract regardless of the authoring surface. Noted for the owner to
> revisit if a reusable rich editor is later extracted.
>
> *Device binding (the point of a Template).* The **Devices** picker now offers
> **both** built-ins (bound by `templateKey`) and v2 templates (bound by
> `templateId`) from the dual-shape `/api/admin/display/templates` GET
> (`{ builtIns, templates }`); picking a v2 template PATCHes `templateId` and
> clears `templateKey`, picking a built-in does the reverse, so the resolution
> order (`templateId → templateKey → club default`) stays unambiguous. Built-ins
> remain pickable until LTV-038 retires them.

> **Reference (LTV-034, #80).** The **Reference** entry
> (`/admin/display/reference`) is live: one read-only page, three Cards, backed
> by the closed registries so a new module/condition/token surfaces with no
> hand-maintained duplication (ADR-003 §3). **Modules** lists each
> `listDisplayModules()` entry — label, name, description, copyable embed token,
> the dependency phrasing derived from the module labels ("needs Chores — hides
> without it"), contributed conditions, and the CSS hooks as inline code.
> **Conditions** groups `listDisplayConditions()` by family (core / occupancy /
> content / capability) with the name as code and description, plus a **live
> indicator** — a "true now" / "false now" badge per condition for the chosen
> lodge. That indicator is a **point-in-time snapshot**: it is computed by the
> admin-guarded status endpoint
> (`GET /api/admin/display/reference/conditions?lodgeId=…`, `requireAdmin`, lodge
> boundary, GET-only, no write) which builds the lodge's DisplayState through the
> same privacy-reduced serialiser the wall uses and evaluates every registry
> condition against it — **refreshed by a button, never polled**. **CSS tokens**
> lists `listDisplayCssTokens()` split into the display palette (with a colour
> swatch each, read from the `.display-shell` palette constants — `display.css`
> is not loaded in the admin bundle, so the swatch reads a static value rather
> than resolving `var(--display-*)`) and the club-brand tokens (per-club, shown
> without a swatch). The page imports only the client-safe registries; the status
> endpoint owns the server side.

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
  always takes precedence over preview parameters. A preview may also carry
  `?previewDate=YYYY-MM-DD` (LTV-017) to start the window on a simulated date
  instead of today, set by clicking the header date line — preview-only, and
  device-token fetches ignore it (malformed values fall back to today). While
  active the header clock recolours amber in place (the date line shows the
  simulated date) so the layout never shifts.
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
- **Unattended safety net (LTV-030, ADR-003 §5).** A lobby wall has nobody
  watching, so a broken v2 template must never blank it:
  - **Page-level fallback board.** The layout screen renders inside a top-level
    error boundary; any whole-screen throw drops to a `FallbackBoard` — the
    `everyday-board` built-in rendered through the proven legacy region path
    (carrying the fixed header and standard footer). It is tagged
    `data-display-fallback` for diagnosis and shows a muted marker
    ("Template failed — showing fallback board") **only** in an admin preview
    (`readPreviewState().isPreview`); a real wall shows no error text.
  - **Render-health flag.** The state route distinguishes *no binding*
    (`templateId` null — the expected legacy path, silent) from a *broken
    binding* (template row/layout missing, or serve-time validation/sanitise
    failure). A broken binding logs at **warn** with the device/template ids and
    attaches `layoutRenderError: true` to the payload (no `layoutRender`); the
    wall silently gets the legacy `template`, while a preview renders the same
    `FallbackBoard` with the marker. The legacy `template` field is **always**
    attached to the payload, so the client always has fallback material.
  - **Save-path validation contract.** `authoring-validation.ts` exposes
    `validateLayoutForSave` / `validateTemplateForSave` — the single server-side
    contract the authoring UIs (#78/#79) call before persisting. Structural
    invalidity is an **error** (save refused); anything the CSS sanitiser would
    strip is a **warning** (save allowed — serve time re-sanitises identically —
    but the author is told what was neutralised). Preview-before-save
    **enforcement** lives in those authoring UI flows, not here.

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
