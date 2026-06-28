-- Addy address autocomplete is an optional public API proxy module. It defaults
-- off so fresh installs and existing saved admin rows must opt in explicitly.
ALTER TABLE "ClubModuleSettings"
  ADD COLUMN "addressAutocomplete" BOOLEAN NOT NULL DEFAULT false;
