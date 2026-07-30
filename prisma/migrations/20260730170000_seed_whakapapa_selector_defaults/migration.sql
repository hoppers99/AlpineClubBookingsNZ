-- Seed the full Whakapapa selector vocabulary into the report cache config
-- (skifieldConditions module).
--
-- Blue/green EXPAND (data seed) migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * No DDL. A single idempotent UPSERT on the cold, single-row
--    "WhakapapaReportCache" table that writes the complete default selector set
--    into config.selectorOverrides so the DATABASE holds the full vocabulary
--    (previously only the code defaults did, with the DB storing sparse
--    overrides). The `||` merge keeps any existing admin override (right-hand
--    side wins), and an existing sourceUrl is preserved, so this never clobbers
--    a site that has already customised its config.
--  * On a fresh insert (no cache row yet) payload is an empty object and
--    fetchedAt is backdated to the epoch so the next public read refetches
--    upstream rather than serving the empty payload as "fresh".
--  Old-colour compatible: the previously deployed client reads config only
--  through coerceWhakapapaSourceConfig, which accepts any subset of known keys
--  and ignores unknown ones, so a fully-populated selectorOverrides is safe. No
--  DROP/RENAME/ALTER, no schema change, no provider call. WhakapapaReportCache
--  is absent from HOT_TABLE_SQL_REGEX. Re-runnable: a second run merges the same
--  defaults under the existing (already-seeded) overrides and is a no-op.
INSERT INTO "WhakapapaReportCache" (
  "id",
  "source",
  "payload",
  "config",
  "fetchedAt",
  "frozenUntil",
  "createdAt",
  "updatedAt"
)
VALUES (
  'seed_whakapapa_report_config',
  'whakapapa-report',
  '{}'::jsonb,
  jsonb_build_object(
    'sourceUrl', 'https://www.whakapapa.com/report',
    'selectorOverrides', $wsel$
{
  "roadAreaTitle": "[class*=\"areaTitle_\"]",
  "roadStatus": "[class*=\"open_\"]:not([class*=\"status_\"]), [class*=\"closed_\"]:not([class*=\"status_\"])",
  "roadWheelRequirements": "[class*=\"wheelRequirements_\"]",
  "roadContent": "[class*=\"roadContent_\"]",
  "sectionWrapper": "[class*=\"wrapper_\"]",
  "sectionHeading": "[class*=\"title_\"]",
  "sectionItems": "[class*=\"items_\"]",
  "item": "[class*=\"item_\"]",
  "itemName": "[class*=\"name_\"]",
  "itemStatus": "[class*=\"status_\"]",
  "conditionRow": "[class*=\"locationRow_\"]",
  "conditionTitle": "[class*=\"locationTitle_\"]",
  "conditionTemperature": "[class*=\"temperature_\"]",
  "trailsHeadingId": "trails",
  "trailArea": "[class*=\"collapsableSection\"]",
  "trailAreaName": "[class*=\"title_\"]",
  "trailDifficultyIcon": "[class*=\"iconWrapper_\"]",
  "trailSubInfo": "[class*=\"subInfo\"]"
}
$wsel$::jsonb
  ),
  -- Explicit UTC values, never the session clock (#1627): a naive timestamp
  -- column would otherwise store local wall-clock and skew ordering.
  timestamp '1970-01-01 00:00:00',
  NULL,
  timezone('UTC', statement_timestamp()),
  timezone('UTC', statement_timestamp())
)
ON CONFLICT ("source") DO UPDATE SET
  "config" = jsonb_build_object(
    'sourceUrl',
    COALESCE(
      NULLIF("WhakapapaReportCache"."config" ->> 'sourceUrl', ''),
      EXCLUDED."config" ->> 'sourceUrl'
    ),
    'selectorOverrides',
    (EXCLUDED."config" -> 'selectorOverrides')
      || COALESCE("WhakapapaReportCache"."config" -> 'selectorOverrides', '{}'::jsonb)
  ),
  "updatedAt" = timezone('UTC', statement_timestamp());
