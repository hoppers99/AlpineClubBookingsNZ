import { prisma } from "../prisma";
import {
  DEFAULT_DISPLAY_TEMPLATE_KEY,
  listBuiltInDisplayTemplates,
  validateDisplayTemplateDefinition,
  type ResolvedDisplayTemplate,
} from "./template-registry";

// SERVER-ONLY template resolution (fork issues #29/#32): DB rows shadow
// built-ins (ADR-002 §2) and are revalidated on every load. Kept separate
// from template-registry.ts, which must stay client-safe (the display page's
// client bundle imports the pure registry; bundling prisma/pg client-side
// breaks the build).

/**
 * Resolve a template key: a DB row (override of a built-in key, or a custom
 * template) wins over the code default (ADR-002 §2, issue #29 AC2). Returns
 * null for an unknown key; throws InvalidDisplayTemplateError if a stored
 * definition fails validation.
 */
export async function resolveDisplayTemplate(
  key: string
): Promise<ResolvedDisplayTemplate | null> {
  const row = await prisma.displayTemplate.findUnique({ where: { key } });
  const builtIn = listBuiltInDisplayTemplates().find(
    (definition) => definition.key === key
  );

  if (row) {
    return {
      definition: validateDisplayTemplateDefinition(row.definition),
      source: builtIn ? "override" : "custom",
    };
  }
  if (builtIn) {
    return { definition: builtIn, source: "built-in" };
  }
  return null;
}

/**
 * Resolve the template a device should render (fork issue #32): its bound
 * DisplayTemplate row when one is set (validated on load), otherwise the
 * built-in default. Binding devices to BUILT-IN templates by key (no DB row)
 * needs a `templateKey` column — deferred to LTV-008 (#33) where the
 * assignment UI lands.
 */
export async function resolveDisplayTemplateForDevice(
  templateId: string | null
): Promise<ResolvedDisplayTemplate> {
  if (templateId) {
    const row = await prisma.displayTemplate.findUnique({
      where: { id: templateId },
    });
    if (row) {
      return {
        definition: validateDisplayTemplateDefinition(row.definition),
        source: "custom",
      };
    }
  }
  const fallback = listBuiltInDisplayTemplates().find(
    (definition) => definition.key === DEFAULT_DISPLAY_TEMPLATE_KEY
  )!;
  return { definition: fallback, source: "built-in" };
}
