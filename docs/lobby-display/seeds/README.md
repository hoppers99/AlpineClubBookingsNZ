# Lobby display seed bundles

Importable config-transfer bundles for the lobby display. Upload through
**Admin → Export & Import Setup → Import** (select the *Lodge configuration*
category), review the plan, and apply. The v2 Layout/Template library travels in
the `lodge-config` category (LTV-037), so the display setup imports as one unit
alongside a club's lodge configuration.

## `room-occupancy-templates.bundle.zip`

The room-occupancy starter set in the v2 Layout/Template shape (ADR-003 §1),
derived from the design-exploration mockups ([`../mockups/`](../mockups/)). The
bundle carries ONLY the club-wide display library — no lodge rows travel (the
`lodge-config/instructions.csv` file is the engine's always-emitted club-wide
base and contains zero rows), so importing cannot touch any lodge's own
settings.

### `display/layouts.json` — two Layouts

| Key | Name | Shape |
|---|---|---|
| `room-occupancy` | Room occupancy board | Full-width board: a single static `{{area:main}}` area holding the arrivals board. |
| `room-occupancy-rotating` | Room occupancy + notices (rotating) | Full-width board whose `main` area is a rotator (12 s) with two children — the board, and a `content:notice`-gated committee notice that only appears while a notice is set. |

### `display/templates.json` — three Templates

| Key | Name | Layout | Fill |
|---|---|---|---|
| `room-occupancy-3day` | Room occupancy — 3 day | `room-occupancy` | `main` → arrivals-board (3-day window) |
| `room-occupancy-week` | Room occupancy — week view | `room-occupancy` | `main` → arrivals-board (7-day window) |
| `occupancy-rotating` | Occupancy + notices | `room-occupancy-rotating` | `main/board` → arrivals-board (3 day); `main/notice` → notice-board |

Templates bind their Layout by **key** (`layoutKey`), never a database id, so the
bundle is portable. On import, layouts apply before templates, and each
`layoutKey` is resolved to the real layout — a template whose `layoutKey` is in
neither the bundle nor the target database is a plan-blocking error.

After importing, the layouts appear on **Admin → Display Layouts** and the
templates on **Admin → Display Templates**; assign a template to a device on
**Admin → Lobby Display**.

Every Layout and Template is validated on import against the shared save
contract (`validateLayoutForSave` / `validateTemplateForSave`) — the exact same
gate the authoring UIs use — so a bundle can never install a structurally broken
display (ADR-003 §5). The bundle was generated through the real export engine
(`buildConfigExport`), so its manifest and checksums are genuine.
