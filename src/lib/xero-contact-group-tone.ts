import type { CategoricalScale } from "@/lib/chip-tones";

const XERO_GROUP_TONES: readonly CategoricalScale[] = [
  "cat1",
  "cat2",
  "cat3",
  "cat4",
  "cat5",
  "cat6",
];

export interface XeroContactGroupIdentity {
  id: string;
}

/**
 * Return one of the six categorical tones for a Xero contact group.
 *
 * The preferred seed is the group's position in the complete, stable catalog
 * supplied by the cached Xero groups endpoint. Positions wrap modulo six, so a
 * seventh group intentionally collides with the first (and so on). Crucially,
 * a member row's subset and its display order never participate in the choice.
 *
 * A row can briefly arrive before the catalog (or refer to a retired group).
 * In that case a deterministic FNV-1a hash of the stable Xero group id supplies
 * the modulo seed. Hash collisions are likewise expected presentation-only
 * collisions; the visible group name remains the source of identity.
 */
export function getXeroContactGroupTone(
  groupId: string,
  catalog: readonly XeroContactGroupIdentity[] = [],
): CategoricalScale {
  const catalogIndex = catalog.findIndex((group) => group.id === groupId);
  if (catalogIndex >= 0) {
    return XERO_GROUP_TONES[catalogIndex % XERO_GROUP_TONES.length];
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < groupId.length; index += 1) {
    hash ^= groupId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return XERO_GROUP_TONES[(hash >>> 0) % XERO_GROUP_TONES.length];
}
