# Lobby display seed bundles

Importable config-transfer bundles for the lobby display. Upload through
**Admin → Export & Import Setup → Import** (select the *Lodge configuration*
category), review the plan, and apply.

## `room-occupancy-templates.bundle.zip`

Three room-occupancy templates derived from the design-exploration mockups
([`../mockups/`](../mockups/)). Contains ONLY display templates — no lodge
rows travel, so importing cannot touch any lodge's own settings.

| Key | Name | Layout |
|---|---|---|
| `room-occupancy-3day` | Room occupancy — 3 day | The everyday bar board: room lanes, one bar per booking, up to 5 names then "+N", 3-day window |
| `room-occupancy-week` | Room occupancy — week view | The same board across the full 7-day window |
| `occupancy-rotating` | Occupancy + notices | Rotating main panel (12 s): bar board → whole-lodge blockout (only while a whole-lodge booking is in window) → committee notice (only while a notice is set) |

After importing, assign a template to a device on **Admin → Lobby Display**,
or set region details on **Admin → Display Templates**.

Every definition is validated on import against the module/condition
registries (ADR-002) — a bundle can never install a broken template. The
bundle was generated through the real export engine
(`buildConfigExport`), so its manifest and checksums are genuine.
