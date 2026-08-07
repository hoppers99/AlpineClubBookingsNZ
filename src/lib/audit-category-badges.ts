import { isAuditCategory, type AuditCategory } from "@/lib/audit-categories";
import { CHIP_TONE_CLASSES } from "@/lib/chip-tones";

/**
 * Single source of truth for the audit-category badge colours (#2137).
 *
 * The member-facing `audit-timeline.tsx` and the admin `/admin/audit-log` page
 * each used to carry their OWN identical copy of this map, so the two surfaces
 * could silently drift apart. They now share this one.
 *
 * These are CATEGORICAL colours: they distinguish sibling categories in one
 * column and must stay stable across every admin-configured theme, so they do
 * not use the brand accent.
 *
 * #2188 P2 — migrated onto the signed-off scale vocabulary (M1-M10, #2181) via
 * CHIP_TONE_CLASSES (the `bg-<scale>-3 text-<scale>-11` step pattern, G2b-AA).
 * Per the sign-off: security folds to `danger` (M3 rose→danger); the semantic
 * categories reuse their scale (booking→success, lodge→warning amber, xero/
 * account→info blue); the remaining categoricals collapse onto cat1..cat6 by hue
 * proximity (payment violet→cat1, communication cyan→cat2, privacy fuchsia→cat3);
 * `family` → cat6 (#2218 — the generated teal 6th scale that retired --hue-teal);
 * admin/system stay neutral. The two accepted collisions (account≡xero on info,
 * admin≡system on neutral) are sibling meta-categories — meaning is carried by
 * icon + label, never colour alone (the M1 "collisions accepted" clause).
 *
 * #2581 — keyed by the canonical `AuditCategory` rather than by `string`, so a
 * category added to the taxonomy without a colour fails to compile instead of
 * silently rendering in the `system` neutral tone alongside genuine system rows.
 */
export const AUDIT_CATEGORY_BADGE_CLASSES: Record<AuditCategory, string> = {
  account: `${CHIP_TONE_CLASSES.info} border-info-6`,
  booking: `${CHIP_TONE_CLASSES.success} border-success-6`,
  payment: `${CHIP_TONE_CLASSES.cat1} border-cat1-6`,
  family: `${CHIP_TONE_CLASSES.cat6} border-cat6-6`,
  admin: `${CHIP_TONE_CLASSES.neutral} border-border`,
  security: `${CHIP_TONE_CLASSES.danger} border-danger-6`,
  lodge: `${CHIP_TONE_CLASSES.warning} border-warning-6`,
  xero: `${CHIP_TONE_CLASSES.info} border-info-6`,
  communication: `${CHIP_TONE_CLASSES.cat2} border-cat2-6`,
  privacy: `${CHIP_TONE_CLASSES.cat3} border-cat3-6`,
  system: `${CHIP_TONE_CLASSES.neutral} border-border`,
};

/**
 * Badge classes for an audit category, falling back to the `system` tone.
 *
 * Still takes a plain `string`: the value reaching a badge is often not a
 * canonical category at all. A legacy row's category is inferred from its action
 * for display (`inferAuditCategoryFromAction`), and historical rows carry values
 * written before the taxonomy was closed. The runtime guard is what keeps those
 * out of the exhaustive map without giving the map a `string` key again.
 */
export function auditCategoryBadgeClass(category: string): string {
  return isAuditCategory(category)
    ? AUDIT_CATEGORY_BADGE_CLASSES[category]
    : AUDIT_CATEGORY_BADGE_CLASSES.system;
}
