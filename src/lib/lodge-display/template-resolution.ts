import {
  DEFAULT_DISPLAY_TEMPLATE_KEY,
  listBuiltInDisplayTemplates,
  type ResolvedDisplayTemplate,
} from "./template-registry";

// Code built-in resolution. Since LTV-038 the three built-ins are SEEDED as v2
// Layout + Template rows and devices bind to them by `templateId`, so this code
// registry is no longer the device render path. It survives for two narrower
// jobs only (its removal belongs to the #86 re-layer):
//
//   1. `resolveDisplayTemplateForDevice` supplies the legacy `template` payload
//      field the state route always attaches — the zero-DB known-good design the
//      client's FallbackBoard renders when a v2 `layoutRender` is absent or
//      broken (LTV-030), and the club-default board for a device with no v2
//      binding (ActiveScreen).
//   2. `resolveDisplayTemplate` still backs the admin `?preview=1&templateKey=…`
//      / `/api/admin/display/preview` testing path (preview the exact fallback
//      board).
//
// A device's `templateKey` column is VESTIGIAL after LTV-038 (never written; the
// seed migrated existing values to `templateId`), so in practice
// `resolveDisplayTemplateForDevice` returns the club default. Client-safe: pure
// data, no database.

/**
 * Resolve a template key to its code built-in, or null for an unknown key.
 */
export function resolveDisplayTemplate(
  key: string
): ResolvedDisplayTemplate | null {
  const builtIn = listBuiltInDisplayTemplates().find(
    (definition) => definition.key === key
  );
  return builtIn ? { definition: builtIn } : null;
}

/**
 * Resolve the template a device should render: its templateKey built-in, else
 * the club default built-in (everyday-board).
 */
export function resolveDisplayTemplateForDevice(device: {
  templateKey: string | null;
}): ResolvedDisplayTemplate {
  if (device.templateKey) {
    const byKey = resolveDisplayTemplate(device.templateKey);
    if (byKey) return byKey;
  }
  const fallback = listBuiltInDisplayTemplates().find(
    (definition) => definition.key === DEFAULT_DISPLAY_TEMPLATE_KEY
  )!;
  return { definition: fallback };
}
