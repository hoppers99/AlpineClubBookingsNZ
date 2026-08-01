import type { CategoricalScale } from "@/lib/chip-tones";

const XERO_GROUP_TONES: readonly CategoricalScale[] = [
  "cat1",
  "cat2",
  "cat3",
  "cat4",
  "cat5",
  "cat6",
];

/**
 * Return one of the six categorical tones for a Xero contact group.
 *
 * A deterministic FNV-1a hash of the stable Xero group id supplies the modulo
 * seed. Catalog availability, filtering, and row order never participate, so
 * Members and Subscriptions cannot assign different tones while their cached
 * catalog-loading policies differ. Hash collisions are expected
 * presentation-only collisions; the visible group name remains authoritative.
 */
export function getXeroContactGroupTone(groupId: string): CategoricalScale {
  let hash = 0x811c9dc5;
  for (let index = 0; index < groupId.length; index += 1) {
    hash ^= groupId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return XERO_GROUP_TONES[(hash >>> 0) % XERO_GROUP_TONES.length];
}
