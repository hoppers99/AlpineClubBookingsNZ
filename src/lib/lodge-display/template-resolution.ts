import {
  DEFAULT_DISPLAY_TEMPLATE_KEY,
  listBuiltInDisplayTemplates,
  type ResolvedDisplayTemplate,
} from "./template-registry";

// Interim template resolution during the v2 rebuild (LTV-024): the old
// DisplayTemplate model is gone, so resolution reads ONLY the code built-ins in
// template-registry.ts. Screens keep rendering the LTV-015/016 boards until the
// authoring layer (LTV-027/033) lands. Kept server-side (the state route imports
// it) though it no longer touches the database.

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
